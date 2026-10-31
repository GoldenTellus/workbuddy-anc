# watchdog：独立计划任务，盯心跳、outbox 积压、WorkBuddy 进程；异常发运维群，带冷却
# 退出码：0 正常或已告警 / 2 环境错误
[CmdletBinding()]
param(
    [string]$WebhookFile = "$env:ProgramData\anc\secrets\ops-webhook.txt",
    [string]$LogFile = "$env:ProgramData\anc\data\loop.log",
    [string]$StateFile = "$env:ProgramData\anc\data\watchdog.state.json",
    [int]$HeartbeatMaxMinutes = 10,
    [int]$PendingMax = 50,
    [int]$CooldownMinutes = 30
)

$ErrorActionPreference = 'Continue'
$problems = @()

# 1 心跳
if (Test-Path $LogFile) {
    $age = [int]((Get-Date) - (Get-Item $LogFile).LastWriteTime).TotalMinutes
    if ($age -gt $HeartbeatMaxMinutes) { $problems += "本地小服务心跳停了 ${age} 分钟（anc-service？）" }
} else { $problems += '没有 loop.log：服务从未跑过' }

# 2 outbox 积压
$pending = 0
try {
    $out = & node "$env:ProgramData\anc\service\cli.ts" --db "$env:ProgramData\anc\data\anc.db" --json outbox list --status pending --limit 100 2>$null | Out-String
    $pending = ([regex]::Matches($out, '"dedupe_key"')).Count
    if ($pending -ge $PendingMax) { $problems += "outbox 积压 $pending 条" }
} catch { $problems += '查 outbox 失败' }

# 3 WorkBuddy
if (-not (Get-Process WorkBuddy -ErrorAction SilentlyContinue)) { $problems += 'WorkBuddy 没在跑（公司 bot 离线）' }

if ($problems.Count -eq 0) { exit 0 }

# 冷却
$state = @{}
if (Test-Path $StateFile) { try { $state = Get-Content $StateFile -Raw | ConvertFrom-Json -AsHashtable } catch { $state = @{} } }
$now = Get-Date
$key = ($problems -join '|')
if ($state.key -eq $key -and $state.at) {
    $mins = ($now - [datetime]$state.at).TotalMinutes
    if ($mins -lt $CooldownMinutes) { exit 0 }
}

if (-not (Test-Path $WebhookFile)) { exit 2 }
$url = (Get-Content $WebhookFile -Raw).Trim()
if (-not $url) { exit 2 }
$body = @{ msgtype = 'text'; text = @{ content = "[anc] watchdog: " + ($problems -join '；') } } | ConvertTo-Json -Depth 4 -Compress
try {
    Invoke-RestMethod -Uri $url -Method Post -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 15 | Out-Null
    [pscustomobject]@{ key = $key; at = $now.ToString('o') } | ConvertTo-Json | Set-Content $StateFile -Encoding utf8
} catch { exit 2 }
exit 0
