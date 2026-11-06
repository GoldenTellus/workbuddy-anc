# devbot 自动启动 —— 把「全员下班」这个信号真正用起来。
#
# 背景：`cli dayend all-off` 能算出 allOff:true，但**没有任何东西消费它**。
# 夜间跑的是固定时间的计划任务（02:00 备份 / 03:00 清媒体），devbot 从来没被自动调过。
# 结果：迭代闭环的最后一环（L4）实际上要人手工跑，不是"全自动"。
#
# ── 规则（这是这个脚本的全部价值，代码只是执行）────────────────
#
# 跑的条件，**全部满足**：
#
#   1. **今天是工作日** —— 周一到周五，且不在 config 的 holidays 里。
#      周末不跑：没人看产出，devbot 改出来的分支要人 review，周末 review 不了。
#
#   2. **名册非空** —— chat_bindings 至少有一条。
#      空名册不是"所有人都下班了"，是"这套系统还没配员工"。
#      这时候跑 devbot 没有意义：产出的分支没有对应的群/人。
#
#   3. **满足下列任一**：
#      a) allOff:true        —— 登记的人都说了下班
#      b) 当前时间 >= 24:00  —— 也就是次日 00:00 之后
#         为什么要有 b：有人忘了说「下班」，或者加班到很晚没说。
#         没有 b 的话，只要一个人忘了说，整夜都不跑。
#
#   4. **有 status='open' 的 issue** —— 没活干就不跑。
#
#   5. **今天还没成功跑过** —— 状态文件里记 lastRunDay，同一天不重复跑。
#      为什么：这个脚本会被计划任务每 30 分钟调一次，不记就去重了。
#
# ── 窗口 ────────────────────────────────────────────────────
#   脚本从 22:00 开始被调用（计划任务），到次日 06:00 停止尝试。
#   06:00 之后就算 allOff 也不跑了——早上人要上班了，产出没时间 review，
#   而且 WorkBuddy 可能已经被员工在用（抢单实例）。
#
# ── 不跑的后果 ──────────────────────────────────────────────
#   不跑**不是错误**。绝大多数时候（白天、周末、没 issue）都不该跑。
#   所以退出码：0 = 正常（含"决定不跑"）/ 1 = 决定要跑但跑失败了 / 2 = 环境错误
#
# 用法：
#   powershell -File scripts\devbot\devbot-scheduler.ps1 -DryRun -Json     # 只看会不会跑，不动
#   powershell -File scripts\devbot\devbot-scheduler.ps1 -Apply            # 真跑
#   powershell -File scripts\devbot\devbot-scheduler.ps1 -Force -Apply     # 忽略时间/去重，强制跑一次
#
# 状态文件：%ProgramData%\anc\data\devbot-scheduler.json
#   { lastRunDay, lastRunAt, lastIssue, lastResult, lastError }

param(
    [string]$Root = '',
    [string]$Repo = '',

    # 真的调 devbot.ps1。不给就是 dry-run（只报"会不会跑"）
    [switch]$Apply,

    # 忽略工作日/时间窗口/当天去重，强制跑一次（排查用）
    [switch]$Force,

    # 把"现在"当成这个时间（测试用，生产**不要传**）。格式 "yyyy-MM-dd HH:mm"。
    #
    # 为什么需要它：窗口判定（22:00~06:00 / 工作日 / 节假日）没法靠等来验证——
    # 要么等到真到 22:00，要么改系统时间（会影响 service / 提醒 / 备份所有定时逻辑，不干）。
    # 注入时间只影响"判断"，不影响后续动作，所以四种分支能一次验完。
    #
    # **参数名不能叫 -Now**：$Now 和 $now 是同一个变量（PowerShell 大小写不敏感），
    # 而 [string] 的类型约束会把后面赋的 DateTime 强制转回字符串，
    # 于是 $now.ToString("yyyy-MM-dd") 报「Cannot find an overload」。
    # 这是这类 bug 第 6 次出现（前五次：$Done/$done、$V/$v、$PSItem、$pid、$args）。
    [string]$AsOf = '',

    [switch]$Json
)

$ErrorActionPreference = 'Stop'

if (-not $Root) { $Root = Join-Path $env:ProgramData 'anc' }
if (-not $Repo) {
    $c = $PSScriptRoot
    while ($c -and -not (Test-Path (Join-Path $c 'src\service\cli.ts'))) {
        $p = Split-Path -Parent $c
        if ($p -eq $c) { break }
        $c = $p
    }
    $Repo = $c
}

$db = Join-Path $Root 'data\anc.db'
$cli = Join-Path $Repo 'src\service\cli.ts'
$stateFile = Join-Path $Root 'data\devbot-scheduler.json'
$configFile = Join-Path $Root 'data\config.json'

# 生产：$AsOf 为空，用真实时间。测试：注入固定时间。
# 注意 $AsOf/$now 不是同一个变量（不同名前缀），不会互相污染。
$now = if ($AsOf) { [datetime]::ParseExact($AsOf, 'yyyy-MM-dd HH:mm', $null) } else { Get-Date }
$today = $now.ToString('yyyy-MM-dd')

# ── 读 config（节假日）──────────────────────────────────────
$holidays = @()
if (Test-Path $configFile) {
    try {
        $cfg = Get-Content $configFile -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($cfg.holidays) { $holidays = @($cfg.holidays) }
    } catch { }
}

# ── 读状态（当天去重）───────────────────────────────────────
$st = $null
if (Test-Path $stateFile) {
    try { $st = Get-Content $stateFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch { }
}

# ── 判定：会不会跑 ──────────────────────────────────────────
$reasons = @()      # 不跑的原因（空 = 会跑）
$facts = [ordered]@{
    now        = $now.ToString('yyyy-MM-dd HH:mm:ss')
    weekday    = $now.DayOfWeek.ToString()
    isWorkday  = $null
    isHoliday  = ($holidays -contains $today)
    rosterSize = $null
    allOff     = $null
    openIssues = $null
    lastRunDay = if ($st) { $st.lastRunDay } else { $null }
}

function Get-CliJson([string[]]$cliArgs) {
    try {
        $out = & node --no-warnings $cli --db $db --json @cliArgs 2>&1 | Out-String
        return ($out | ConvertFrom-Json)
    } catch { return $null }
}

if (-not (Test-Path $db)) {
    $reasons += '库不存在: ' + $db
} else {
    # ① 工作日
    $dow = [int]$now.DayOfWeek      # Sunday=0 ... Saturday=6
    $isWeekend = ($dow -eq 0 -or $dow -eq 6)
    $facts.isWorkday = (-not $isWeekend) -and (-not $facts.isHoliday)
    if ($isWeekend) { $reasons += '今天是周末（' + $facts.weekday + '），devbot 产出的分支要人 review，周末没人看' }
    elseif ($facts.isHoliday) { $reasons += ('今天是节假日（' + $today + ' 在 config.holidays 里）') }

    # ② 时间窗口：22:00 ~ 次日 06:00
    $hour = $now.Hour
    $inWindow = ($hour -ge 22) -or ($hour -lt 6)
    $facts.inWindow = $inWindow
    if (-not $inWindow) { $reasons += ('当前 ' + $now.ToString('HH:mm') + ' 不在窗口内（22:00 ~ 次日 06:00）') }

    # ③ 名册与下班判定
    $ao = Get-CliJson @('dayend', 'all-off')
    if ($null -eq $ao) {
        $reasons += 'dayend all-off 跑不起来'
    } else {
        $facts.rosterSize = @($ao.roster).Count
        $facts.allOff = [bool]$ao.allOff
        if ($facts.rosterSize -eq 0) {
            # 空名册不是"都下班了"，是"还没配员工"——产出没有对应的群/人
            $reasons += '名册为空（chat_bindings 没有员工）：这不是「都下班了」，是「还没配员工」，产出没人接收'
        } else {
            # ④ 晚上 22:00 之后 OR allOff 成立
            #    注意：inWindow 已经保证时间在 22:00~06:00，所以这里只需要判 allOff 或 已过零点
            $afterMidnight = ($hour -lt 6)
            if (-not $ao.allOff -and -not $afterMidnight) {
                $pending = @($ao.pending) -join ', '
                $reasons += ('还有人在上班（' + $pending + '），且还没过零点')
            }
            $facts.afterMidnight = $afterMidnight
        }
    }

    # ⑤ 有 open issue 吗
    $il = Get-CliJson @('issue', 'list', '--status', 'open')
    if ($null -eq $il) {
        $reasons += 'issue list 跑不起来'
    } else {
        $openCount = @($il.issues).Count
        $facts.openIssues = $openCount
        if ($openCount -eq 0) { $reasons += '没有 status=open 的 issue，没活干' }
    }

    # ⑥ 当天去重
    if ($st -and $st.lastRunDay -eq $today -and $st.lastResult -eq 'ok') {
        $reasons += ('今天已经成功跑过（issue #' + $st.lastIssue + '，' + $st.lastRunAt + '）')
    }
}

if ($Force) {
    $reasons = @()   # 强制跑：忽略所有条件，但仍然记录跳过的原因
    $facts.forced = $true
}

$willRun = ($reasons.Count -eq 0)

# ── 决定要跑：取第一条 open issue ──────────────────────────
$targetIssue = 0
$issueInfo = $null
if ($willRun) {
    $il2 = Get-CliJson @('issue', 'list', '--status', 'open')
    $first = @($il2.issues) | Select-Object -First 1
    if ($first) {
        $targetIssue = [int]$first.id
        $issueInfo = [pscustomobject]@{
            id      = $first.id
            skill   = $first.skill
            section = $first.section
            symptom = ([string]$first.symptom).Substring(0, [Math]::Min(60, ([string]$first.symptom).Length))
        }
    } else {
        $willRun = $false
        $reasons += '要跑的时候发现没有 open issue（可能刚被别的进程处理了）'
    }
}

# ── 真跑 ────────────────────────────────────────────────────
$runResult = ''
$runError = ''
if ($Apply -and $willRun) {
    # ChatId / UserId：devbot.ps1 需要它们来注入。从 chat_bindings 取第一条。
    $bindChat = ''
    $bindUser = ''
    $bl = Get-CliJson @('bind', 'list')
    if ($bl -and $bl.bindings) {
        $b0 = @($bl.bindings) | Select-Object -First 1
        if ($b0) { $bindChat = [string]$b0.chat_id; $bindUser = [string]$b0.userid }
    }
    if (-not $bindChat) {
        $runResult = 'failed'
        $runError = '没有可用的 chat_binding，devbot.ps1 需要 -ChatId 才能注入'
    } else {
        $devbot = Join-Path $Repo 'scripts\devbot\devbot.ps1'
        if (-not (Test-Path $devbot)) {
            $runResult = 'failed'
            $runError = "找不到 $devbot"
        } else {
            try {
                $dArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $devbot, '-Issue', $targetIssue, '-Repo', $Repo, '-ChatId', $bindChat)
                if ($bindUser) { $dArgs += @('-UserId', $bindUser) }
                $dArgs += '-Apply'
                $out = & powershell @dArgs 2>&1 | Out-String
                # devbot.ps1 的退出码：0 成功 / 非 0 失败
                if ($LASTEXITCODE -eq 0) { $runResult = 'ok' } else { $runResult = 'failed'; $runError = 'devbot.ps1 退出码 ' + $LASTEXITCODE }
                # 把关键几行记下来（不记全文，太长）
                $tail = ($out -split "`r?`n" | Where-Object { $_ -match '产出有效|分支|提交数|x ' }) -join ' | '
                if ($tail) { $runError = if ($runError) { $runError + ' :: ' + $tail } else { $tail } }
            } catch {
                $runResult = 'failed'
                $runError = $_.Exception.Message
            }
        }
    }
}

# ── 写状态（只在真跑后写）───────────────────────────────────
if ($Apply -and $runResult) {
    $newState = [pscustomobject]@{
        lastRunDay  = $today
        lastRunAt   = $now.ToString('yyyy-MM-dd HH:mm:ss')
        lastIssue   = $targetIssue
        lastResult  = $runResult
        lastError   = $runError
    }
    $dir = Split-Path -Parent $stateFile
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $tmp = $stateFile + '.tmp'
    [IO.File]::WriteAllText($tmp, ($newState | ConvertTo-Json -Depth 4), (New-Object Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $tmp -Destination $stateFile -Force
}

# ── 输出 ────────────────────────────────────────────────────
$out = [pscustomobject]@{
    willRun  = $willRun
    applied  = [bool]$Apply
    reason   = if ($willRun) { '条件全部满足' } else { $reasons -join '；' }
    issue    = $targetIssue
    issueInfo = $issueInfo
    result   = $runResult
    error    = $runError
    facts    = $facts
}

if ($Json) {
    $out | ConvertTo-Json -Depth 5
} else {
    Write-Host '=== devbot-scheduler ==='
    Write-Host ('时间: {0}  周{1}{2}' -f $facts.now, $facts.weekday, $(if ($facts.isHoliday) { '（节假日）' } else { '' }))
    Write-Host ('名册: {0} 人   allOff={1}   open issue={2}' -f $facts.rosterSize, $facts.allOff, $facts.openIssues)
    Write-Host ''
    if ($willRun) {
        Write-Host ('WOULD RUN  issue #' + $targetIssue + '  (' + $issueInfo.skill + ' / ' + $issueInfo.section + ')')
        Write-Host ('           ' + $issueInfo.symptom)
    } else {
        Write-Host 'WOULD SKIP'
        foreach ($r in $reasons) { Write-Host ('  - ' + $r) }
    }
    if ($Apply) {
        Write-Host ''
        if ($runResult -eq 'ok') { Write-Host ('RAN       issue #' + $targetIssue + ' 成功') }
        elseif ($runResult) { Write-Host ('RAN       issue #' + $targetIssue + ' 失败: ' + $runError) }
        else { Write-Host 'RAN       没跑（条件不满足）' }
    } else {
        Write-Host ''
        Write-Host '（dry-run：加 -Apply 才真跑）'
    }
}

# 退出码：正常（含决定不跑）= 0；决定跑但失败 = 1
if ($Apply -and $runResult -eq 'failed') { exit 1 }
exit 0
