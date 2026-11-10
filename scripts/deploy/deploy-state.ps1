# 部署进度状态 —— 让 agent 装到一半失败后能"接着做"，不用从头来。
#
# 为什么需要它：
#   部署不是一步，是十几步（建目录 → 部署文件 → 装技能 → 打补丁 → 注册任务 → ...）。
#   这台机器上"打补丁"这一环折腾过很多次（VERIFY §37），装到那里失败时如果能接着做，
#   agent 就不用重复已完成的事、也不会覆盖已改好的东西。
#
# 设计原则：
#   1. **状态文件是唯一真相** —— agent 不看日志猜进度，只读这个 JSON
#   2. **每步显式 mark** —— 不去推断"应该算做完了"，由执行者说
#   3. **failed 要带 reason** —— 重跑时 agent 要知道上次卡在哪、为什么
#   4. **不用锁** —— 两个人同时装一台机器本身就是错的
#
# ⚠️ 两个 PowerShell 语义坑（都在这份文件里踩过）：
#
#   ① if 表达式返回单元素数组会解包成标量
#      $a = if ($true) { @('x') } else { @() }   → $a 是 String，不是 Object[]
#      后果：$a += $y 变成字符串拼接，`-contains` 全部不匹配，数据被静默清空。
#      规矩：数组一律显式初始化（$a = @() 然后 if 里赋值），不靠 if 返回值。
#
#   ② 参数名和变量名大小写不敏感
#      param([switch]$Done) 和内部 $done 是同一个变量，赋数组给它直接抛类型错。
#      规矩：switch 一律加 As 前缀（-AsDone / -AsFailed），内部变量用 doneList / failedId。
#      今天栽在这上面的：$V/$v、$PSItem、$pid、$args、$Done、$Failed。
#
# ⚠️ 命名约定（踩过的坑）：
#   PowerShell 参数和变量**大小写不敏感**，`param([switch]$Done)` 和内部 `$done`
#   是同一个变量。赋数组/字符串给 SwitchParameter 会直接抛
#   "Cannot convert ... to SwitchParameter"。
#   所以所有 switch 一律用 As 前缀：-AsDone / -AsFailed，内部变量用 doneList / failedId。
#   今天栽在这上面的：$V/$v、$PSItem、$pid、$args、$Done、$Failed。
#
# 用法：
#   deploy-state.ps1 -Side company -Status -Json
#   deploy-state.ps1 -Side company -Mark dirs -AsDone -Json
#   deploy-state.ps1 -Side company -Mark patch -AsFailed -Reason "ANCHOR-MISS" -Json
#   deploy-state.ps1 -Side company -Next -Json
#   deploy-state.ps1 -Side company -Reset -Apply
#
# 退出码：0 正常（含"全部完成"）/ 1 有 failed 未处理 / 2 用法错误

param(
    [ValidateSet('company', 'employee')]
    [string]$Side = 'company',

    [string]$Root = '',

    [switch]$Status,
    [switch]$Next,
    [switch]$Reset,
    [switch]$Apply,

    [string]$Mark = '',
    [switch]$AsDone,
    [switch]$AsFailed,
    [string]$Reason = '',

    [switch]$Json
)

$ErrorActionPreference = 'Stop'

if (-not $Root) {
    $Root = if ($Side -eq 'company') { Join-Path $env:ProgramData 'anc' } else { Join-Path $env:LOCALAPPDATA 'anc' }
}

$stateFile = Join-Path $Root 'data\deploy-state.json'

# ── 阶段定义（和 docs/DEPLOY-*.md 的章节一一对应）──────────
# 公司侧顺序与手册一致：装空 WorkBuddy 是「第 0 步」（人做），preflight 在它之后。
# 2026-11-10 修：原来 preflight 排第一，agent 按 state 的 next 推进会先跑前置检查、
# 再回头发现手册要求先装 WorkBuddy，两边对不上。
$Stages = if ($Side -eq 'company') {
    @(
        @{ id = 'brief'; title = '递准备清单给人（§0，deploy-kickoff -Phase prepare）' },
        @{ id = 'answers'; title = '收齐并校验信息（§1，deploy-kickoff -Phase check）' },
        @{ id = 'workbuddy'; title = 'WorkBuddy 已装（§2，第 0 步，人做）' },
        @{ id = 'preflight'; title = '前置检查（§3）' },
        @{ id = 'dirs'; title = '建目录结构（§4）' },
        @{ id = 'files'; title = '部署运行件（§5，deploy.ps1）' },
        @{ id = 'skills'; title = '部署技能（§6，deploy-skills.ps1）' },
        @{ id = 'patch'; title = '打补丁（§7，patch-guard / selfheal）' },
        @{ id = 'tasks'; title = '注册 14 个计划任务（§8）' },
        @{ id = 'vault'; title = '建 vault 两区（§9）' },
        @{ id = 'org'; title = '写 org 数据 + 渲染 persona（§10）' },
        @{ id = 'wecom'; title = '配企微（§11，corpid / 群机器人 webhook）' },
        @{ id = 'verify'; title = '自证（§12，deploy-verify.ps1）' }
    )
} else {
    @(
        @{ id = 'brief'; title = '递准备清单给人（§0，deploy-kickoff -Phase prepare）' },
        @{ id = 'answers'; title = '收齐并校验信息（§1，deploy-kickoff -Phase check）' },
        @{ id = 'preflight'; title = '前置检查（§2）' },
        @{ id = 'workbuddy'; title = 'WorkBuddy 已装并登录（§3）' },
        @{ id = 'files'; title = '部署运行件（§4，deploy.ps1）' },
        @{ id = 'skills'; title = '部署技能（§5）' },
        # §5.5 同步渲染产物：persona / groups.json / company.md 只能从公司侧拷，
        # deploy.ps1 只放渲染器源码、不生成产物。原先没有这个阶段，
        # agent 做完 skills 直接跳 persona，卡在「没有你的 persona」时也没有地方记录。
        @{ id = 'sync'; title = '从公司侧同步渲染产物（§5.5）' },
        @{ id = 'persona'; title = '部署个人 persona（§6）' },
        @{ id = 'bind'; title = '绑定本人的群（§7）' },
        @{ id = 'verify'; title = '自证（§8）' }
    )
}

$stageIds = @($Stages | ForEach-Object { $_.id })

function Read-State {
    if (-not (Test-Path $stateFile)) { return $null }
    try {
        $raw = [IO.File]::ReadAllText($stateFile, [Text.Encoding]::UTF8).TrimStart([char]0xFEFF)
        return ($raw | ConvertFrom-Json)
    } catch { return $null }
}

function Write-StateFile($obj) {
    $dir = Split-Path -Parent $stateFile
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $tmp = $stateFile + '.tmp'
    [IO.File]::WriteAllText($tmp, ($obj | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $tmp -Destination $stateFile -Force
}

# ── 统一的输出构造（三个动作共用同一个契约）───────────────
function Build-View($st) {
    # 不用 if 表达式返回数组：单元素时 PowerShell 会解包成标量（见文件头说明）
    $doneList = @()
    if ($null -ne $st -and $null -ne $st.done) { $doneList = @($st.done) }
    $failedId = if ($st) { [string]$st.failed } else { '' }
    $errText = if ($st) { [string]$st.error } else { '' }

    $remaining = @($Stages | Where-Object { $doneList -notcontains $_.id })
    $nextId = if ($remaining.Count) { $remaining[0].id } else { '' }
    $nextTitle = if ($remaining.Count) { $remaining[0].title } else { '' }

    $nextAction = if (-not $st) {
        # 第一步是 brief 不是 preflight：先给人递准备清单，再收信息（GAP-095）。
        '还没开始。先跑 deploy-kickoff.ps1 -Phase prepare -Side ' + $Side + '，把准备清单递给安装人；信息收齐（-Phase check 返回 ok）再往下装。'
    } elseif ($failedId) {
        '上次卡在 ' + $failedId + '（' + $errText + '）。修好之后重跑那一步，再 -Mark ' + $failedId + ' -AsDone。**不要从头来**。'
    } elseif ($remaining.Count -eq 0) {
        '全部阶段已完成。'
    } else {
        '下一步：' + $nextId + '（' + $nextTitle + '）'
    }

    return [pscustomobject]@{
        ok        = (-not $failedId) -and ($remaining.Count -eq 0)
        side      = $Side
        stage     = $nextId
        done      = $doneList
        failed    = $failedId
        error     = $errText
        at        = if ($st) { [string]$st.at } else { '' }
        progress  = ('{0}/{1}' -f $doneList.Count, $stageIds.Count)
        remaining = @($remaining | ForEach-Object { $_.id })
        next      = $nextAction
        stages    = @($Stages | ForEach-Object {
            [pscustomobject]@{
                id    = $_.id
                title = $_.title
                state = if ($doneList -contains $_.id) { 'done' } elseif ($failedId -eq $_.id) { 'failed' } else { 'pending' }
            }
        })
    }
}

function Show-View($v) {
    Write-Host ("=== deploy-state ({0}) ===" -f $v.side)
    Write-Host ("进度 {0}" -f $v.progress)
    Write-Host ''
    foreach ($s in $v.stages) {
        $mark = switch ($s.state) { 'done' { '[x]' } 'failed' { '[!]' } default { '[ ]' } }
        Write-Host ("  {0} {1,-10} {2}" -f $mark, $s.id, $s.title)
    }
    if ($v.failed) { Write-Host ''; Write-Host ("FAILED  {0}  {1}" -f $v.failed, $v.error) }
    Write-Host ''
    Write-Host ("NEXT  {0}" -f $v.next)
}

function Emit($v, [int]$code) {
    if ($Json) {
        # PS 5.1 默认按 GBK 往 stdout 写；调用方（node execFileSync encoding:'utf8'、
        # agent 的 2>&1）按 UTF-8 读会把中文 reason / next 读成 mojibake。
        # 2026-11-05 全量测试有 3 条因此红（deploy-state.test.ts），与 doctor 的
        # bindings 误报是同一个根因。只在 -Json 分支切，finally 不必恢复（进程即将退出）。
        try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
        $v | ConvertTo-Json -Depth 5
    } else { Show-View $v }
    exit $code
}

# ── Reset ───────────────────────────────────────────────────
if ($Reset) {
    if (-not $Apply) { Write-Host 'dry-run：加 -Apply 才真删'; exit 0 }
    if (Test-Path $stateFile) { Remove-Item -LiteralPath $stateFile -Force; Write-Host "已清空 $stateFile" }
    else { Write-Host "本来就没有 $stateFile" }
    exit 0
}

# ── Mark ────────────────────────────────────────────────────
if ($Mark) {
    if (-not ($AsDone -or $AsFailed)) { Write-Host 'ERROR -Mark 要配 -AsDone 或 -AsFailed'; exit 2 }
    if ($stageIds -notcontains $Mark) {
        Write-Host ("ERROR 未知阶段: {0}（可选: {1}）" -f $Mark, ($stageIds -join ', '))
        exit 2
    }

    $st = Read-State
    # 同 Build-View：不用 if 表达式返回数组（单元素会解包成标量）。
    # 第一版漏改这里，表现是"第一次 mark 对、之后每次都把 done 清空"。
    $doneList = @()
    if ($null -ne $st -and $null -ne $st.done) { $doneList = @($st.done) }

    if ($AsDone) {
        if ($doneList -notcontains $Mark) { $doneList += $Mark }
        $newFailed = ''
        $newErr = ''
    } else {
        $newFailed = $Mark
        $newErr = $Reason
    }

    $doneSorted = @($stageIds | Where-Object { $doneList -contains $_ })
    $remaining = @($stageIds | Where-Object { $doneSorted -notcontains $_ })
    $newStage = if ($newFailed) { $newFailed } else { (@($remaining | Select-Object -First 1) -join '') }

    $newState = [pscustomobject]@{
        side   = $Side
        stage  = $newStage
        done   = $doneSorted
        failed = $newFailed
        at     = (Get-Date).ToString('o')
        error  = $newErr
    }
    Write-StateFile $newState

    $v = Build-View $newState
    if (-not $Json) {
        Write-Host ("MARKED  {0} → {1}" -f $Mark, $(if ($AsDone) { 'done' } else { 'FAILED: ' + $Reason }))
    }
    Emit $v $(if ($AsFailed) { 1 } else { 0 })
}

# ── Status / Next ───────────────────────────────────────────
$st = Read-State
$v = Build-View $st
Emit $v $(if ($v.failed) { 1 } else { 0 })
