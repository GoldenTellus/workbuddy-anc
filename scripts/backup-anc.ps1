# ANC 数据库备份：VACUUM INTO 一致性快照 + 本地保留 + 可选离机复制
# 退出码：0 成功 / 1 备份失败 / 2 环境错误

[CmdletBinding()]
param(
    [string]$SourceDb = "$env:ProgramData\anc\data\anc.db",
    [string]$BackupDir = "$env:ProgramData\anc\backup",
    [string]$Destination = '',
    [int]$Keep = 14
)

$ErrorActionPreference = 'Continue'
$log = Join-Path $env:ProgramData 'anc\data\backup.log'
function Write-Log([string]$m) {
    $line = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $m
    Add-Content -Path $log -Value $line -Encoding utf8 -ErrorAction SilentlyContinue
    Write-Host $line
}

if (-not (Test-Path $SourceDb)) { Write-Log "ERROR 源库不存在: $SourceDb"; exit 2 }

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = 'C:\Program Files\nodejs\node.exe' }
if (-not (Test-Path $node)) { Write-Log 'ERROR 找不到 node.exe'; exit 2 }

New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$target = Join-Path $BackupDir "anc-$stamp.db"

& $node "$env:ProgramData\anc\service\cli.ts" backup --db $SourceDb --to $target *> $null
if (-not (Test-Path $target)) { Write-Log "ERROR 备份失败: $target"; exit 1 }
$size = (Get-Item $target).Length
if ($size -le 0) { Write-Log "ERROR 备份文件为空: $target"; exit 1 }
Write-Log ("OK " + $target + " size=" + $size)

# 本地保留最近 N 份
$old = Get-ChildItem $BackupDir -Filter 'anc-*.db' | Sort-Object LastWriteTime -Descending | Select-Object -Skip $Keep
if ($old) { $old | Remove-Item -Force -ErrorAction SilentlyContinue; Write-Log ("pruned " + $old.Count + " old backup(s)") }

# 离机复制（目标不可达只告警，不算备份失败）
if ($Destination) {
    try {
        Copy-Item $target $Destination -Force -ErrorAction Stop
        Write-Log "offsite copied -> $Destination"
    } catch {
        Write-Log ("WARN offsite copy failed: " + $_.Exception.Message)
    }
}

exit 0
