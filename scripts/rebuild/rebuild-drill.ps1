# 重建演练：在一个空目录里按 REBUILD.md 走一遍，测出基线耗时并验证部署结构。
#
# 为什么需要它：V6 要求"干净机重建计时"，但没有第二台干净机。演练不能替代真机，
# 但能回答两个问题——(1) 按 runbook 做出来的目录结构 doctor 认不认；(2) 每一步花多久。
# 更重要的是：runbook 里手工列复制清单的写法已经和 deploy.ps1 漂移过（漏了 src\shared），
# 演练会直接把这类问题暴露出来。
#
# 用法：powershell -File scripts\rebuild\rebuild-drill.ps1 [-Root <空目录>] [-Keep]
# 退出码：0 结构可用 / 1 结构不对 / 2 用法错误
param(
    [string]$Repo = '',
    [string]$Root = '',
    [switch]$Keep
)

$ErrorActionPreference = 'Stop'
if (-not $Repo) {
    $c = $PSScriptRoot
    while ($c -and -not (Test-Path (Join-Path $c 'src\service\cli.ts'))) {
        $p = Split-Path -Parent $c
        if ($p -eq $c) { break }
        $c = $p
    }
    $Repo = $c
}
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
if (-not $Root) { $Root = Join-Path $env:TEMP ('anc-drill-' + $stamp) }

if (Test-Path $Root) {
    $existing = @(Get-ChildItem $Root -Force -ErrorAction SilentlyContinue)
    if ($existing.Count -gt 0) {
        Write-Host "FAIL  演练根已存在且非空: $Root" -ForegroundColor Red
        Write-Host '     换一个空目录，或先手动清掉（本脚本不删已存在的目录，避免误伤）'
        exit 2
    }
}

$timings = [ordered]@{}
function Step([string]$name, [scriptblock]$body) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    & $body
    $sw.Stop()
    $timings[$name] = [math]::Round($sw.Elapsed.TotalSeconds, 1)
    Write-Host ('  {0,-28} {1,6:N1}s' -f $name, $sw.Elapsed.TotalSeconds)
}

Write-Host "重建演练 @ $stamp"
Write-Host "  仓库: $Repo"
Write-Host "  演练根: $Root`n"

# ---- 步骤 1：建目录（对应 REBUILD.md §1）----
Step '建目录结构' {
    # 与 deploy.ps1 的 $Map 里出现的 Target 对齐；新增映射时这里要跟着加
    $dirs = 'data', 'secrets', 'service', 'skills', 'bin', 'backup', 'accounts',
            'ingest', 'render', 'shared', 'patch'
    foreach ($d in $dirs) { New-Item -ItemType Directory -Force (Join-Path $Root $d) | Out-Null }
}

# ---- 步骤 2：部署运行件（对应 §3；用 deploy.ps1，不手工列清单）----
$deployOk = $true
Step '部署运行件（deploy -Apply）' {
    $out = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Repo 'scripts\deploy\deploy.ps1') -Repo $Repo -Root $Root -Apply 2>&1
    $code = $LASTEXITCODE
    if ($code -ne 0) {
        $script:deployOk = $false
        Write-Host ($out | Select-Object -Last 6) -ForegroundColor Red
    } else {
        $line = ($out | Select-Object -Last 2)[0]
        Write-Host "  $line" -ForegroundColor DarkGray
    }
}

if (-not $deployOk) {
    Write-Host "`nFAIL  部署失败，演练中止；演练根保留在 $Root" -ForegroundColor Red
    exit 1
}

# ---- 步骤 3：doctor 认不认这个结构（对应 §5 的一部分）----
$layoutState = '(未取到)'
Step 'doctor 校验结构' {
    $out = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root 'bin\doctor.ps1') -Repo $Repo -Root $Root -Json 2>&1
    try {
        $j = ($out -join "`n") | ConvertFrom-Json
        $item = $j.checks | Where-Object { $_.check -eq 'deploy-layout' }
        if ($item) { $script:layoutState = $item.state }
    } catch {
        # doctor 在空根上会有一堆 FAIL（没 DB、没任务、没 ACL），JSON 仍应可解析
        $script:layoutState = '(JSON 解析失败)'
    }
}

# ---- 汇总 ----
$total = [math]::Round(($timings.Values | Measure-Object -Sum).Sum, 1)
Write-Host "`n  合计 $total s"
Write-Host "  deploy-layout: $layoutState"

# 部署出来的文件数
$deployed = @(Get-ChildItem $Root -Recurse -File | Where-Object { $_.FullName -notmatch '\\backup\\' })
Write-Host "  部署文件数: $($deployed.Count)"

$ok = ($layoutState -eq 'PASS')
if ($ok) {
    Write-Host "`nPASS  结构可用（真机还要过 §2 恢复数据、§3 注册任务、§4 恢复 bot）" -ForegroundColor Green
} else {
    Write-Host "`nFAIL  deploy-layout = $layoutState，按 runbook 做出来的结构 doctor 不认" -ForegroundColor Red
}

# 记一行基线，便于以后对比"重建变慢了多少"
$baseline = Join-Path $Repo '_research\rebuild-baseline.log'
New-Item -ItemType Directory -Force (Split-Path -Parent $baseline) | Out-Null
("$stamp`t" + ($timings.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)s" }) -join ' ' + "`ttotal=${total}s`tfiles=$($deployed.Count)`tlayout=$layoutState") |
    Add-Content -Path $baseline -Encoding UTF8
Write-Host "  基线已追加: $baseline"

if (-not $Keep) {
    Remove-Item $Root -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "  演练根已清理（-Keep 可保留）"
} else {
    Write-Host "  演练根保留在 $Root"
}

if ($ok) { exit 0 } else { exit 1 }
