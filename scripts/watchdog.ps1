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

# 3 WorkBuddy（自愈正在重启时给 5 分钟宽限，避免误报）
if (-not (Get-Process WorkBuddy -ErrorAction SilentlyContinue)) {
    $starting = $false
    $gs = "$env:ProgramData\anc\data\patch-guard.state.json"
    if (Test-Path $gs) {
        try {
            $raw = [IO.File]::ReadAllText($gs, [Text.Encoding]::UTF8).TrimStart([char]0xFEFF)
            $last = [datetime]($raw | ConvertFrom-Json).lastStartAt
            if (((Get-Date) - $last).TotalMinutes -lt 5) { $starting = $true }
        } catch { }
    }
    if (-not $starting) { $problems += 'WorkBuddy 没在跑（公司 bot 离线）' }
}

# 4 补丁 canary：补丁生效但取不到 chatId（上游字段改名）
$canary = "$env:ProgramData\anc\data\patch-canary.json"
if (Test-Path $canary) {
    try {
        $c = Get-Content $canary -Raw | ConvertFrom-Json
        $hours = ((Get-Date) - [datetime]$c.at).TotalHours
        if ($hours -lt 24 -and -not $c.chatId) { $problems += '补丁生效但取不到 chatId（上游字段可能改名，需人工重放）' }
    } catch { }
}

if ($problems.Count -eq 0) { exit 0 }

# 冷却
$state = @{}
# -AsHashtable 是 PS 6+ 才有的参数，5.1 下会抛错被吞掉，冷却永远不生效；用 PSCustomObject 读即可
if (Test-Path $StateFile) {
    try { $state = [IO.File]::ReadAllText($StateFile, [Text.Encoding]::UTF8).TrimStart([char]0xFEFF) | ConvertFrom-Json } catch { $state = @{} }
}
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
