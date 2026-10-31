# 开机提醒：启动后检查 WorkBuddy 是否在跑；不在就经运维群 webhook 告警
# 由计划任务 anc-boot-alert 在开机时触发，每 10 分钟重试，2 小时后停。
# 退出码：0 正常或已告警 / 2 环境错误

[CmdletBinding()]
param(
    [string]$WebhookFile = "$env:ProgramData\anc\secrets\ops-webhook.txt",
    [int]$WaitSeconds = 60
)

$ErrorActionPreference = 'Continue'

Start-Sleep -Seconds $WaitSeconds

$proc = Get-Process WorkBuddy -ErrorAction SilentlyContinue
if ($proc) { exit 0 }

if (-not (Test-Path $WebhookFile)) { Write-Host 'no ops webhook, skip'; exit 2 }
$url = (Get-Content $WebhookFile -Raw).Trim()
if (-not $url) { Write-Host 'ops webhook empty, skip'; exit 2 }

$body = @{
    msgtype = 'text'
    text    = @{ content = '[anc] 主机已重启，但 WorkBuddy 还没起来：公司 bot 当前离线，请登录专用用户恢复。' }
} | ConvertTo-Json -Depth 4 -Compress

try {
    Invoke-RestMethod -Uri $url -Method Post -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 15 | Out-Null
    Write-Host 'alert sent'
} catch {
    Write-Host ('alert failed: ' + $_.Exception.Message)
    exit 2
}
exit 0
