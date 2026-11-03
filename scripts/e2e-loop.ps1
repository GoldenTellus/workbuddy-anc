# 迭代闭环端到端（PLAN 阶段 L7）
#
# 一条真实反馈从进来到出现改动，全程留痕：
#
#   [L1] 注入员工原话        → submissions 多一行
#   [L2] draft issue         → issues 多一行，分诊出 skill/section
#   [L3] patch draft（模板）  → patch_drafts 多一行，产出可应用的 diff
#   [L4] devbot 全自动       → devbot/issue-<N> 分支 + 提交（-WithDevbot 时做）
#   [L6] eval                → 跑用例，出 pass/fail
#
# 每一步都把证据打印出来，最后汇总成一份报告写到 _research/e2e-<时间>.md（不进 git）。
#
# 用法：
#   powershell -File scripts\e2e-loop.ps1                                   # 预检
#   powershell -File scripts\e2e-loop.ps1 -Apply                            # 跑到 L3 + eval
#   powershell -File scripts\e2e-loop.ps1 -Apply -WithDevbot                # 含 devbot（多 7 分钟）
#
# 退出码：0 全绿 / 1 有环节失败 / 2 用法或环境错误

[CmdletBinding()]
param(
    [string]$Text = '刚才查任务那条回复又不对了：我问「今天有什么任务」，它把上周逾期的也列出来了。应该只列今天到期的。',
    [string]$Repo = '',
    [string]$ChatId = '',
    [string]$UserId = '',
    [switch]$Apply,
    [switch]$WithDevbot
)

$ErrorActionPreference = 'Stop'
$Root = Join-Path $env:ProgramData 'anc'
$Db = Join-Path $Root 'data\anc.db'
$Cli = Join-Path $Root 'service\cli.ts'
$Results = [ordered]@{}
$Failures = 0

function Step($n, $msg) { Write-Host ""; Write-Host "=== [$n] $msg ===" }
function Ok($msg) { Write-Host "  OK   $msg" }
function Bad($msg) { Write-Host "  FAIL $msg"; $script:Failures++ }
function Info($msg) { Write-Host "  ..   $msg" }

function J($args_) {
    $out = & node --no-warnings $Cli --db $Db --json @args_ 2>&1 | Out-String
    try { return $out | ConvertFrom-Json } catch { return $null }
}

if (-not $Repo) { $Repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path) }
if (-not $ChatId) { Write-Host "ERROR 缺少 -ChatId"; exit 2 }
if (-not $UserId) { Write-Host "ERROR 缺少 -UserId"; exit 2 }

$chatShort = if ($ChatId.Length -gt 12) { $ChatId.Substring(0, 12) } else { $ChatId }
Write-Host "反馈原文: $Text"
Write-Host "群: $chatShort…  仓库: $Repo"
Write-Host "devbot: $(if ($WithDevbot) { '含（多 7 分钟）' } else { '跳过（加 -WithDevbot 才做）' })"

if (-not $Apply) {
    Write-Host ""
    Write-Host "[e2e] 预检模式。加 -Apply 才真跑。"
    exit 0
}

# ── 前置：test-emit 就绪 ────────────────────────────────
Step 'pre' '等 test-emit 就绪'
$ready = $false
for ($i = 1; $i -le 12; $i++) {
    Start-Sleep -Seconds 5
    try {
        $payload = @{ chatId = $ChatId; user = 'e2e-probe'; content = 'probe' } | ConvertTo-Json -Compress
        $r = Invoke-RestMethod -Uri 'http://127.0.0.1:17999/emit' -Method Post -ContentType 'application/json; charset=utf-8' `
            -Body ([System.Text.Encoding]::UTF8.GetBytes($payload)) -TimeoutSec 8
        $ready = $true; break
    } catch { }
}
if (-not $ready) { Bad 'test-emit 没就绪（重启后要 8–30 秒；检查 test-emit.flag）'; }
else { Ok "第 $i 次就绪" }

$SubBefore = (J 'submission' 'list' '--limit' '500').submissions.Count
$IssueBefore = (J 'issue' 'list' '--limit' '500').issues.Count
Info "基线：submissions=$SubBefore  issues=$IssueBefore"

# ── L1 ──────────────────────────────────────────────────
Step 'L1' '注入员工原话 → submissions'
$outLog = Join-Path $Root 'data\patch-out.log'
$payload = @{
    chatId = $ChatId; user = $UserId
    msgId = ([guid]::NewGuid().ToString('N'))
    content = $Text
} | ConvertTo-Json -Compress
try {
    $r = Invoke-RestMethod -Uri 'http://127.0.0.1:17999/emit' -Method Post -ContentType 'application/json; charset=utf-8' `
        -Body ([System.Text.Encoding]::UTF8.GetBytes($payload)) -TimeoutSec 15
    Ok '已注入'
} catch { Bad "注入失败: $($_.Exception.Message)" }

# 等 submissions 多一行（bot 要 1–3 分钟）
$sub = $null
for ($i = 1; $i -le 30; $i++) {
    Start-Sleep -Seconds 8
    $list = J 'submission' 'list' '--limit' '500'
    $n = $list.submissions.Count
    if ($i % 4 -eq 0) { Info "$($i*8)s… submissions=$n" }
    if ($n -gt $SubBefore) {
        $sub = $list.submissions | Where-Object { $_.text -eq $Text } | Select-Object -First 1
        if (-not $sub) { $sub = $list.submissions | Select-Object -First 1 }
        break
    }
}
if ($sub) {
    Ok "submission #$($sub.id)  employee=$($sub.employee)  status=$($sub.status)"
    Info "原话一字不差: $($sub.text -eq $Text)"
    $Results.L1 = "submission #$($sub.id)"
} else {
    Bad '4 分钟内没有新 submission'
    $Results.L1 = 'FAILED'
}

# ── L2 ──────────────────────────────────────────────────
Step 'L2' 'submission → 结构化 issue'
if ($sub) {
    $d = J 'issue' 'draft' '--submission' "$($sub.id)"
    if ($d -and $d.ok) {
        $iss = $d.issue
        Ok "issue #$($iss.id)  skill=$($iss.skill)  section=$($iss.section)  needTriage=$($d.needTriage)"
        Info "symptom : $($iss.symptom)"
        Info "expected: $($iss.expected)"
        $Results.L2 = "issue #$($iss.id) ($($iss.skill) / $($iss.section))"
    } else { Bad "draft 失败: $($d | ConvertTo-Json -Compress)" ; $Results.L2 = 'FAILED' }
} else { Bad 'L1 没成，跳过'; $Results.L2 = 'SKIPPED' }

$issueId = if ($iss) { $iss.id } else { $null }

# ── L3 ──────────────────────────────────────────────────
Step 'L3' 'issue → patch draft（模板版）'
if ($issueId) {
    $p = J 'patch' 'draft' '--issue' "$issueId" '--repo' $Repo
    if ($p -and $p.ok) {
        Ok "draft #$($p.draft.id)  插入 $($p.insertedLines) 行  目标 $($p.draft.skill_path)  §$($p.draft.section)"
        if ($p.draft.warnings) { Info "warnings: $($p.draft.warnings)" }
        # 把 diff 写到 _research 里，方便人看（不进 git）
        $patchFile = Join-Path $Repo "_research\e2e-issue$issueId.patch"
        [System.IO.File]::WriteAllText($patchFile, $p.draft.diff, (New-Object System.Text.UTF8Encoding($false)))
        Info "diff 已写到 $(Split-Path $patchFile -Leaf)（$(($p.draft.diff -split "`n").Count) 行）"
        $Results.L3 = "draft #$($p.draft.id)，$($p.insertedLines) 行"
    } else { Bad "patch draft 失败: $($p | ConvertTo-Json -Compress)" ; $Results.L3 = 'FAILED' }
} else { Bad 'L2 没成，跳过'; $Results.L3 = 'SKIPPED' }

# ── L4（可选）──────────────────────────────────────────
Step 'L4' 'devbot 全自动出分支'
if (-not $WithDevbot) {
    Info '跳过（没加 -WithDevbot）'
    $Results.L4 = 'SKIPPED'
} elseif ($issueId) {
    $branch = "devbot/issue-$issueId"
    $existing = @(& git -C $Repo branch --list $branch 2>&1 | Where-Object { $_ -match '\S' })
    if ($existing.Count -gt 0) {
        Info "分支 $branch 已存在，跳过（先 git branch -D $branch 才能重跑）"
        $Results.L4 = "已存在 $branch"
    } else {
        Info '调 devbot.ps1（最多 7 分钟）'
        $devOut = powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Repo 'scripts\devbot.ps1') `
            -Issue $issueId -ChatId $ChatId -UserId $UserId -Apply 2>&1 | Out-String
        $devOk = $devOut -match '产出有效'
        $devOut -split "`r?`n" | Where-Object { $_ -match '分支存在|提交数|改了文件|产出有效|产出有问题|x ' } | ForEach-Object { Info $_.Trim() }
        if ($devOk) { Ok "分支 $branch 产出有效"; $Results.L4 = "branch $branch" }
        else { Bad 'devbot 产出有问题'; $Results.L4 = 'FAILED' }
    }
} else { Bad 'L2 没成，跳过'; $Results.L4 = 'SKIPPED' }

# ── L6 ──────────────────────────────────────────────────
Step 'L6' 'eval 跑用例'
$cases = (J 'eval' 'list' '--repo' $Repo).cases
$caseIds = @($cases | ForEach-Object { $_.id })
Info "用例: $($caseIds -join ', ')"
$evalResults = @()
foreach ($cid in $caseIds) {
    $e = J 'eval' 'run' '--case' $cid '--repo' $Repo '--chat-id' $ChatId '--user-id' $UserId '--timeout' '300'
    if ($e) {
        $line = "$cid = $($e.verdict)"
        $evalResults += $line
        if ($e.verdict -eq 'pass') { Ok $line } else { Info $line }
    } else { Bad "$cid 跑失败" }
}
$Results.L6 = ($evalResults -join '; ')
$passN = @($evalResults | Where-Object { $_ -match '= pass' }).Count
Info "pass $passN / $($caseIds.Count)"

# ── 汇总 ────────────────────────────────────────────────
Write-Host ""
Write-Host "========== 端到端汇总 =========="
foreach ($kv in $Results.GetEnumerator()) {
    Write-Host ("  {0,-4} {1}" -f $kv.Key, $kv.Value)
}
Write-Host ""
if ($Failures -eq 0) { Write-Host "  全绿" } else { Write-Host "  $Failures 个环节失败" }

# 报告落盘（_research 不进 git）
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$report = Join-Path $Repo "_research\e2e-$stamp.md"
$lines = @(
    "# 端到端 $stamp",
    '',
    "反馈原文：$Text",
    '',
    '| 环节 | 结果 |',
    '|---|---|'
)
foreach ($kv in $Results.GetEnumerator()) { $lines += "| $($kv.Key) | $($kv.Value) |" }
$lines += @('', "失败环节：$Failures", '', "生成于 $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')")
[System.IO.File]::WriteAllText($report, ($lines -join "`n"), (New-Object System.Text.UTF8Encoding($false)))
Write-Host ""
Write-Host "  报告: _research\$(Split-Path $report -Leaf)"

if ($Failures -gt 0) { exit 1 }
exit 0
