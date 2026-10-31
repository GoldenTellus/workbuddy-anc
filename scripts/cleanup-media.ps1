# 清理企微附件落地目录：删掉各用户 TEMP 下超过 N 天的文件
# 供计划任务 anc-cleanup 调用（SYSTEM 运行，才能访问 bot 用户的 TEMP）
# 注意：SYSTEM 的 $env:TEMP 是 C:\Windows\Temp，必须显式扫用户目录，否则等于空跑
# 退出码：0 正常 / 2 环境错误

[CmdletBinding()]
param(
    [string]$MediaDir = '',
    [int]$Days = 7
)

$ErrorActionPreference = 'Continue'
$log = 'C:\ProgramData\anc\data\cleanup.log'
function Write-Log([string]$m) {
    $line = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $m
    Add-Content -Path $log -Value $line -Encoding utf8 -ErrorAction SilentlyContinue
    Write-Host $line
}

$targets = @()
if ($MediaDir) {
    $targets += $MediaDir
} else {
    $targets += Get-ChildItem 'C:\Users\*\AppData\Local\Temp\workbuddy-wecom-media' -Directory -ErrorAction SilentlyContinue |
        ForEach-Object { $_.FullName }
    if ($env:TEMP) {
        $fallback = Join-Path $env:TEMP 'workbuddy-wecom-media'
        if ((Test-Path $fallback) -and -not ($targets -contains $fallback)) { $targets += $fallback }
    }
}

if (-not $targets.Count) { Write-Log 'skip: no media dir found'; exit 0 }

$cutoff = (Get-Date).AddDays(-$Days)
$total = 0
$freedTotal = 0
foreach ($dir in $targets) {
    if (-not (Test-Path $dir)) { continue }
    $old = Get-ChildItem $dir -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -lt $cutoff }
    if (-not $old) { Write-Log "clean: nothing older than $Days day(s) in $dir"; continue }
    $freed = 0
    $count = 0
    foreach ($f in $old) {
        try { Remove-Item $f.FullName -Force -ErrorAction Stop; $count++; $freed += $f.Length }
        catch { Write-Log ("WARN delete failed: " + $f.FullName) }
    }
    $total += $count
    $freedTotal += $freed
    Write-Log ("clean: removed $count file(s), " + [math]::Round($freed / 1MB, 2) + " MB from $dir")
}
Write-Log ("done: $total file(s), " + [math]::Round($freedTotal / 1MB, 2) + " MB total")
exit 0
