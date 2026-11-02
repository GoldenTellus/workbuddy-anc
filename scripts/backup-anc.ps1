# ANC 数据库备份：VACUUM INTO 一致性快照 + 本地保留 + 可选离机复制
# 退出码：0 成功（含"跳过"与"离机失败但本地成功"）/ 1 备份失败 / 2 环境错误
#
# 本地备份和"离机备份"是两件事：同一块盘上的两个目录不算离机，盘坏了一起没。
# 所以这里会检查目标与本地备份是否同一块物理盘，同盘时发告警，不静默放过。

[CmdletBinding()]
param(
    [string]$SourceDb = "$env:ProgramData\anc\data\anc.db",
    [string]$BackupDir = "$env:ProgramData\anc\backup",
    [string]$Destination = '',
    [int]$Keep = 14,
    # 离机目录按天保留份数；每月 1 号那份单独保留，避免"只留最近两周"把月档挤掉
    [int]$OffsiteKeep = 60,
    [int]$OffsiteMonthlyKeep = 12,
    # 距上次成功备份不足这个小时数就跳过：计划任务改成每小时跑，错过 02:00 也能补上
    [int]$MinIntervalHours = 20
)

$ErrorActionPreference = 'Continue'
$log = Join-Path $env:ProgramData 'anc\data\backup.log'
function Write-Log([string]$m) {
    $line = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $m
    Add-Content -Path $log -Value $line -Encoding utf8 -ErrorAction SilentlyContinue
    Write-Host $line
}

# 运维告警：备份这种"平时看不出坏"的东西，失败必须主动喊出来
function Send-OpsAlert([string]$text) {
    $ops = Join-Path $env:ProgramData 'anc\secrets\ops-webhook.txt'
    if (-not (Test-Path $ops)) { Write-Log 'WARN 没有 ops-webhook.txt，告警发不出去'; return }
    try {
        $url = (Get-Content $ops -Raw).Trim()
        if (-not $url) { return }
        $body = @{ msgtype = 'text'; text = @{ content = "[anc] 备份: " + $text } } | ConvertTo-Json -Depth 4 -Compress
        Invoke-RestMethod -Uri $url -Method Post -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 15 | Out-Null
    } catch {
        Write-Log ('WARN 告警发送失败: ' + $_.Exception.Message)
    }
}

# 取路径所在物理盘号；拿不到返回 $null（网络路径、权限不足等）
function Get-DiskNumber([string]$path) {
    try {
        $full = [System.IO.Path]::GetFullPath($path)
        $letter = $full.Substring(0, 1)
        if ($letter -notmatch '^[A-Za-z]$') { return $null }
        $p = Get-Partition -DriveLetter $letter -ErrorAction Stop
        return [int]$p.DiskNumber
    } catch { return $null }
}

if (-not (Test-Path $SourceDb)) { Write-Log "ERROR 源库不存在: $SourceDb"; Send-OpsAlert "源库不存在，备份无法进行: $SourceDb"; exit 2 }

# 幂等：最近一次成功备份还在窗口内就跳过（配合每小时触发，补上错过的 02:00）
$last = Get-ChildItem $BackupDir -Filter 'anc-*.db' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($last) {
    $ageHours = ((Get-Date) - $last.LastWriteTime).TotalHours
    if ($ageHours -lt $MinIntervalHours) {
        Write-Log ("skip: last backup " + [math]::Round($ageHours, 1) + "h ago (< $MinIntervalHours h)")
        exit 0
    }
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = 'C:\Program Files\nodejs\node.exe' }
if (-not (Test-Path $node)) { Write-Log 'ERROR 找不到 node.exe'; Send-OpsAlert '找不到 node.exe，备份失败'; exit 2 }

New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$target = Join-Path $BackupDir "anc-$stamp.db"

& $node "$env:ProgramData\anc\service\cli.ts" backup --db $SourceDb --to $target *> $null
# cli 退出码非 0（含完整性校验失败）一律算失败，并删掉可能残留的半截文件
if ($LASTEXITCODE -ne 0) {
    Remove-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue
    Write-Log "ERROR 备份失败（cli 退出码 $LASTEXITCODE）: $target"
    Send-OpsAlert "本地备份失败（cli 退出码 $LASTEXITCODE），请检查磁盘空间与数据库"
    exit 1
}
if (-not (Test-Path $target)) { Write-Log "ERROR 备份失败: $target"; Send-OpsAlert '备份文件没有生成'; exit 1 }
$size = (Get-Item $target).Length
if ($size -le 0) { Write-Log "ERROR 备份文件为空: $target"; Send-OpsAlert '备份文件为空'; exit 1 }
Write-Log ("OK " + $target + " size=" + $size)

# 本地保留最近 N 份
$old = Get-ChildItem $BackupDir -Filter 'anc-*.db' | Sort-Object LastWriteTime -Descending | Select-Object -Skip $Keep
if ($old) { $old | Remove-Item -Force -ErrorAction SilentlyContinue; Write-Log ("pruned " + $old.Count + " old backup(s)") }

# 离机复制（目标不可达只告警，不算备份失败）
if ($Destination) {
    # 独立性：同盘的两个目录不叫离机备份
    $diskLocal = Get-DiskNumber $BackupDir
    $diskOff = Get-DiskNumber $Destination
    if ($null -ne $diskLocal -and $null -ne $diskOff -and $diskLocal -eq $diskOff) {
        $msg = "离机目录与本地备份在同一块物理盘（Disk $diskLocal），盘坏会一起丢；请换独立磁盘或网络位置"
        Write-Log ('WARN ' + $msg)
        # 只告警一次：生产每小时跑一次，同一块盘会天天重复，喊成噪音就没人看了
        $stateFile = Join-Path $env:ProgramData 'anc\data\backup.state.json'
        $lastWarn = $null
        if (Test-Path $stateFile) {
            try { $lastWarn = ([IO.File]::ReadAllText($stateFile, [Text.Encoding]::UTF8).TrimStart([char]0xFEFF) | ConvertFrom-Json).sameDisk } catch { }
        }
        if ($lastWarn -ne $diskLocal) {
            Send-OpsAlert $msg
            [pscustomobject]@{ sameDisk = $diskLocal; at = (Get-Date).ToString('o') } | ConvertTo-Json | Set-Content $stateFile -Encoding utf8
        } else {
            Write-Log 'WARN (same-disk already alerted, not repeating)'
        }
    }

    try {
        New-Item -ItemType Directory -Path $Destination -Force -ErrorAction Stop | Out-Null
        Copy-Item $target $Destination -Force -ErrorAction Stop
        Write-Log "offsite copied -> $Destination"

        # 离机保留：按天 N 份；每月 1 号那份单独算一档
        $offsite = @(Get-ChildItem $Destination -Filter 'anc-*.db' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending)
        $monthly = @($offsite | Where-Object { $_.Name -match '^anc-\d{6}01-' })
        $daily = @($offsite | Where-Object { $_.Name -notmatch '^anc-\d{6}01-' })
        $drop = @()
        $drop += @($daily | Select-Object -Skip $OffsiteKeep)
        $drop += @($monthly | Select-Object -Skip $OffsiteMonthlyKeep)
        if ($drop.Count -gt 0) {
            $drop | Remove-Item -Force -ErrorAction SilentlyContinue
            Write-Log ('offsite pruned ' + $drop.Count + ' old backup(s)')
        }
    } catch {
        $msg = '离机复制失败（本地备份仍然有效）: ' + $_.Exception.Message
        Write-Log ('WARN ' + $msg)
        Send-OpsAlert $msg
    }
}

exit 0
