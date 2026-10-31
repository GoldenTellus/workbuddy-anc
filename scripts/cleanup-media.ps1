# 清理企微附件落地目录：只删指定目录里超过 N 天的文件
# 供计划任务 anc-cleanup 调用（SYSTEM 运行，才能访问 bot 用户的 TEMP）
# 退出码：0 正常 / 2 环境错误

[CmdletBinding()]
param(
    [string]$MediaDir = "$env:TEMP\workbuddy-wecom-media",
    [int]$Days = 7
)

$ErrorActionPreference = 'Continue'
$log = 'C:\ProgramData\anc\data\cleanup.log'
function Write-Log([string]$m) {
    $line = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $m
    Add-Content -Path $log -Value $line -Encoding utf8 -ErrorAction SilentlyContinue
    Write-Host $line
}

if (-not (Test-Path $MediaDir)) { Write-Log "skip: no media dir ($MediaDir)"; exit 0 }

$cutoff = (Get-Date).AddDays(-$Days)
$old = Get-ChildItem $MediaDir -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -lt $cutoff }
if (-not $old) { Write-Log "clean: nothing older than $Days day(s) in $MediaDir"; exit 0 }

$freed = 0
$count = 0
foreach ($f in $old) {
    $freed += $f.Length
    try { Remove-Item $f.FullName -Force -ErrorAction Stop; $count++ } catch { Write-Log ("WARN delete failed: " + $f.FullName) }
}
Write-Log ("clean: removed $count file(s), " + [math]::Round($freed / 1MB, 2) + " MB from $MediaDir")
exit 0
