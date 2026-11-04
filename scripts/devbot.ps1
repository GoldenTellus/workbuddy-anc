# devbot 夜间编排：切 persona → 注入一条 issue → 等它改 → 检查 → 出分支 → 恢复
#
# 为什么是"注入指令"而不是"脚本自己改"：
#   PLAN §5.1 定的是「用一个现成 agent 去改技能」，项目里不写 agent 框架。
#   所以这里只做编排（切人格、投指令、看结果），"怎么改"交给 WorkBuddy 自己想。
#
# 为什么能用：
#   2026-11-04 实测 run_command 工具能跑系统命令并返回输出（node -e "console.log(6*7)" → 42），
#   所以 devbot 才有办法读文件、改文件、跑 git。
#
# 安全边界（三层，都不靠自觉）：
#   1. 分支：只让它在 devbot/issue-<N> 上提交，main 不碰
#   2. 部署：persona 里写死不跑 deploy.ps1；就算跑了也是幂等的
#   3. 生产状态：%ProgramData%\anc 有 ACL，同账号虽然能读，但 persona 明令禁止 + 这里事后检查 git 状态
#
# 用法：
#   powershell -File scripts\devbot.ps1 -Issue 2                 # 预检（不切 persona、不注入）
#   powershell -File scripts\devbot.ps1 -Issue 2 -Apply          # 真跑一次
#   powershell -File scripts\devbot.ps1 -Restore                 # 只恢复 persona
#
# 退出码：0 成功 / 1 产出有问题 / 2 用法或环境错误

[CmdletBinding()]
param(
    [int]$Issue = 0,
    [string]$Repo = '',
    [string]$ChatId = '',
    [string]$UserId = '',

    # WorkBuddy 的 CODEBUDDY.md 路径。默认按当前用户的 %USERPROFILE% 算。
    # 为什么要能覆盖：这个脚本会以计划任务身份跑（anc-devbot）。
    # 2026-11-05 实测：principal 若是 SYSTEM，%USERPROFILE% 变成
    #   C:\Windows\system32\config\systemprofile —— 那里没有 WorkBuddy，
    # 切 persona 会静默写到错误的位置。显式传这个参数能让错误立刻暴露。
    [string]$LivePersona = '',
    [int]$TimeoutSec = 420,
    [switch]$Apply,
    [switch]$Restore
)

$ErrorActionPreference = 'Stop'
function Fail($msg, $fix, $code) { Write-Host "ERROR $msg"; if ($fix) { Write-Host "FIX   $fix" }; exit $code }
function Step($msg) { Write-Host "[devbot] $msg" }

if (-not $Repo) { $Repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path) }
$Root = Join-Path $env:ProgramData 'anc'
if (-not $LivePersona) { $LivePersona = Join-Path $env:USERPROFILE 'WorkBuddy\Claw\CODEBUDDY.md' }

# 启动自检：persona 路径必须存在。
# 不做这个检查的话，principal 配错（比如 SYSTEM）会一路跑到 Copy-Item 才炸，
# 而且错误信息是「找不到路径」——看不出是身份问题。
if (-not (Test-Path (Split-Path -Parent $LivePersona))) {
    $personaDir = Split-Path -Parent $LivePersona
    $who = $env:USERNAME
    Fail "persona 目录不存在: $personaDir（当前用户 $who）" "如果当前用户是 SYSTEM，说明 anc-devbot 的 principal 配错了——改成管理员账号，或显式传 -LivePersona" 2
}
$DevPersona = Join-Path $Repo 'light\personas\devbot\CODEBUDDY.md'
$ProdPersona = Join-Path $Repo 'light\personas\company-bot\CODEBUDDY.md'
$Db = Join-Path $Root 'data\anc.db'
$Cli = Join-Path $Root 'service\cli.ts'
$StateFile = Join-Path $Root 'data\devbot.state.json'

# 记下起始分支：devbot 会把仓库切到 devbot/issue-<N> 去提交，跑完必须切回来，
# 否则下一次 deploy 会拿错分支的技能去部署（2026-11-04 在 e2e-loop 上踩过，devbot 也一样）。
$startBranch = (& git -C $Repo rev-parse --abbrev-ref HEAD 2>&1 | Out-String).Trim()

# ── 恢复 ────────────────────────────────────────────────
if ($Restore -or -not $Apply) {
    if ($Restore) {
        if (-not (Test-Path $ProdPersona)) { Fail "找不到公司 bot 的 persona: $ProdPersona" $null 2 }
        Copy-Item $ProdPersona $LivePersona -Force
        Remove-Item $StateFile -Force -ErrorAction SilentlyContinue
        Step "persona 已恢复成公司 bot 版"
        Step "注意：WorkBuddy 每会话首次注入才读盘（VERIFY §18），要开新会话才生效"
        exit 0
    }
}

if ($Issue -le 0) { Fail "缺少 -Issue <编号>" '先 cli issue list --status open 看有哪些' 2 }
if (-not $ChatId) { Fail "缺少 -ChatId" '用 chat_bindings 里的完整 chatId' 2 }
if (-not (Test-Path $DevPersona)) { Fail "找不到 devbot persona: $DevPersona" '确认 light\personas\devbot\CODEBUDDY.md 在' 2 }

# ── 预检 ────────────────────────────────────────────────
Step "预检 Issue #$Issue"
$issueJson = & node --no-warnings $Cli --db $Db --json issue list --status open 2>&1 | Out-String
try { $issues = ($issueJson | ConvertFrom-Json).issues } catch { Fail "读 issue 失败: $issueJson" $null 2 }
$target = $issues | Where-Object { $_.id -eq $Issue } | Select-Object -First 1
if (-not $target) { Fail "issue #$Issue 不存在或不是 open" 'cli issue list --status open' 2 }
if (-not $target.skill -or -not $target.section) {
    Fail "issue #$Issue 还没分诊（skill/section 为空）" "先 cli issue triage --id $Issue --skill <技能> --section <章节>" 2
}

$branch = "devbot/issue-$Issue"
$baseBranch = (& git -C $Repo rev-parse --abbrev-ref HEAD 2>&1 | Out-String).Trim()
$dirty = @(& git -C $Repo status --porcelain 2>&1 | Where-Object { $_ -match '\S' })
if ($dirty.Count -gt 0) {
    Step "工作区有 $($dirty.Count) 个未提交改动："
    $dirty | Select-Object -First 5 | ForEach-Object { Write-Host "    $_" }
    Fail "工作区不干净，devbot 不该在有未提交改动时动手" '先提交或 stash' 2
}
Step "基线分支: $baseBranch（干净）"
Step "目标分支: $branch"

# ── 目标分支已存在？先改名保留 ────────────────────────────
# 2026-11-05 修：原来不检查这个，模型拿到 "出 devbot/issue-N 分支" 的指令后
#   git checkout -b 会失败（分支已存在），然后它要么切到旧分支、要么停下。
# 前者更糟：检查会通过（分支在、有提交、改了文件），但内容是上一次的旧产出。
#
# 为什么改名而不是删除：issue 还是 open 才走到这里，说明上次产出没被采纳；
# 但"没被采纳"不等于"没价值"，直接删会丢东西。改名保留，人早上能看到两份。
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$existing = @(& git -C $Repo branch --list $branch 2>&1 | Where-Object { $_ -match "\S" })
if ($existing.Count -gt 0) {
    if ($Apply) {
        $bakBranch = "$branch-bak-$stamp"
        & git -C $Repo branch -m $branch $bakBranch 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) {
            Step "目标分支已存在，改名保留: $bakBranch"
        } else {
            Fail "目标分支 $branch 已存在且改名失败" "手动执行 git branch -m $branch $bakBranch" 2
        }
    } else {
        # dry-run 不动任何东西（改名是破坏性操作，预检阶段只报告）
        Step "目标分支已存在（dry-run 不改名；加 -Apply 时会先改名为 $branch-bak-<时间戳>）"
    }
}
Step "issue: skill=$($target.skill)  section=$($target.section)"
# PowerShell 5.1 没有 ?? 运算符（那是 PS 7+），用 if 表达式代替
$sympRaw = if ($target.symptom) { [string]$target.symptom } else { '' }
$expRaw = if ($target.expected) { [string]$target.expected } else { '(空)' }
$symptomLine = ($sympRaw -split "`n")[0]
$expectedLine = ($expRaw -split "`n")[0]
Step "symptom: $symptomLine"
Step "expected: $expectedLine"

if (-not $Apply) {
    Step ""
    Step "预检通过。加 -Apply 才会真的切 persona 并注入指令。"
    exit 0
}

# ── 切 persona ──────────────────────────────────────────
# $stamp 已在上面定义（备份分支名和 persona 备份共用同一个时间戳，便于对照）
$backup = Join-Path $Root "data\persona-backup-$stamp.md"
Copy-Item $LivePersona $backup -Force
Copy-Item $DevPersona $LivePersona -Force
@{ issued = $Issue; branch = $branch; base = $baseBranch; personaBackup = $backup; at = (Get-Date).ToUniversalTime().ToString('o') } |
    ConvertTo-Json | Set-Content $StateFile -Encoding UTF8
Step "persona 已切到 devbot 版（备份: $(Split-Path $backup -Leaf)）"

try {
    # ── 注入指令 ────────────────────────────────────────
    $prompt = @"
devbot 任务：issue #$Issue

技能：$($target.skill)
章节：$($target.section)
现象：$($target.symptom)
期望：$($target.expected)
仓库：$Repo
分支：$branch

按 CODEBUDDY.md 里的流程做：只读三样东西（issue、SKILL.md、用例），想清楚为什么这段会让模型做出员工不满意的事，
只改「$($target.section)」附近，用 `git checkout -b $branch` 建**新**分支并提交（这个分支名现在不存在，可以直接建），然后跑 eval 确认没改坏。
最后回一句给早上看的人：改了什么、分支名、eval 结果。
"@

    Step "注入指令（等最多 $TimeoutSec 秒）"
    $outLog = Join-Path $Root 'data\patch-out.log'
    $before = if (Test-Path $outLog) { @(Get-Content $outLog | Where-Object { $_ -match '^(\S+)\s+chat=' }).Count } else { 0 }

    $payload = @{ chatId = $ChatId; user = $UserId; msgId = ([guid]::NewGuid().ToString('N')); content = $prompt } | ConvertTo-Json -Compress
    try {
        $r = Invoke-RestMethod -Uri 'http://127.0.0.1:17999/emit' -Method Post -ContentType 'application/json; charset=utf-8' `
            -Body ([System.Text.Encoding]::UTF8.GetBytes($payload)) -TimeoutSec 15
        Step "已注入（HTTP ok）"
    } catch {
        Fail "注入失败: $($_.Exception.Message)" '检查 test-emit 是否在跑（test-emit.flag + 重启后 8–30 秒）' 2
    }

    # ── 等它干完 ────────────────────────────────────────
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    $lastCount = $before
    $lastChange = Get-Date
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 8
        $now = if (Test-Path $outLog) { @(Get-Content $outLog | Where-Object { $_ -match '^(\S+)\s+chat=' }).Count } else { 0 }
        if ($now -gt $lastCount) { $lastCount = $now; $lastChange = Get-Date }
        # 有新回复且安静了 40 秒 → 认为说完了
        if ($lastCount -gt $before -and ((Get-Date) - $lastChange).TotalSeconds -ge 40) { break }
    }
    Step "等待结束（收到 $($lastCount - $before) 条回复）"

    # ── 检查产出 ────────────────────────────────────────
    Step "检查产出"
    $branches = @(& git -C $Repo branch --list $branch 2>&1)
    $onBranch = $branches.Count -gt 0
    $commits = if ($onBranch) { @(& git -C $Repo log --oneline "$baseBranch..$branch" 2>&1 | Where-Object { $_ -match '\S' }) } else { @() }
    $changed = @(& git -C $Repo diff --name-only "$baseBranch..$branch" 2>&1 | Where-Object { $_ -match '\S' })

    Write-Host ""
    Write-Host "  分支存在: $onBranch"
    Write-Host "  提交数:   $($commits.Count)"
    $commits | ForEach-Object { Write-Host "    $_" }
    Write-Host "  改了文件: $($changed.Count)"
    $changed | ForEach-Object { Write-Host "    $_" }

    $bad = 0
    if (-not $onBranch) { Write-Host "  x 没出分支"; $bad++ }
    if ($commits.Count -eq 0) { Write-Host "  x 没有提交"; $bad++ }
    if ($changed.Count -eq 0) { Write-Host "  x 分支上没有任何文件改动"; $bad++ }
    # 越界检查：只允许改技能和用例
    $outOfScope = @($changed | Where-Object { $_ -notmatch '^light/(skills|evals)/' })
    if ($outOfScope.Count -gt 0) {
        Write-Host "  x 改了范围外的文件："
        $outOfScope | ForEach-Object { Write-Host "      $_" }
        $bad++
    }
    # main 有没有被动过
    $mainMoved = (& git -C $Repo rev-parse "$baseBranch" 2>&1 | Out-String).Trim()
    Write-Host "  $baseBranch 的 HEAD: $mainMoved"

    Write-Host ""
    if ($bad -eq 0) {
        Step "产出有效：分支 $branch 上有 $($commits.Count) 个提交，改了 $($changed.Count) 个文件，全在允许范围内"

        # 把 issue 标成 drafted：分支已经有了，等早上人 review。
        # 不标的话 issue 永远停在 open，而 `prune-closed` 只扫 closed——
        # 那样"清理已修好问题的技能提醒"就永远触发不了（2026-11-04 发现）。
        try {
            $mark = & node --no-warnings $Cli --db $Db --json issue set-status --id $Issue --to drafted --note "devbot 产出分支 $branch" 2>&1 | Out-String
            if ($LASTEXITCODE -eq 0) { Write-Host "  issue #$Issue → drafted" }
            else { Write-Host "  WARN 标 drafted 失败（不影响分支）: $(('' + $mark).Trim().Substring(0, [Math]::Min(120, $mark.Trim().Length)))" }
        } catch { Write-Host "  WARN 标 drafted 失败（不影响分支）: $($_.Exception.Message)" }
        Step "早上看这个就够了：git -C $Repo log --oneline $baseBranch..$branch"
        exit 0
    } else {
        Step "产出有问题（$bad 项），看上面的 x 行"
        exit 1
    }
} finally {
    # ── 无论成败都恢复 persona ──────────────────────────
    if (Test-Path $backup) {
        Copy-Item $backup $LivePersona -Force
        Step "persona 已恢复（备份留在 $(Split-Path $backup -Leaf)）"
    }

    # 切回起始分支：不切回去的话，下一次 deploy 会拿 devbot 分支的技能去部署
    $curBranch = (& git -C $Repo rev-parse --abbrev-ref HEAD 2>&1 | Out-String).Trim()
    if ($startBranch -and $curBranch -ne $startBranch) {
        & git -C $Repo checkout $startBranch 2>&1 | Out-Null
        $nowBranch = (& git -C $Repo rev-parse --abbrev-ref HEAD 2>&1 | Out-String).Trim()
        if ($nowBranch -eq $startBranch) { Step "已切回 $startBranch" }
        else { Write-Host "  WARN 切回 $startBranch 失败，现在在 $nowBranch" }
    }
    Remove-Item $StateFile -Force -ErrorAction SilentlyContinue
}
