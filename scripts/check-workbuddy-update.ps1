# 主动查 WorkBuddy 新版：204=无新版；200=有新版，发运维群（同一版本只告警一次）
# 由计划任务 anc-update-watch 每天跑
[CmdletBinding()]
param(
    [string]$Platform = 'workbuddy-win32-x64-user',
    [string]$WebhookFile = "$env:ProgramData\anc\secrets\ops-webhook.txt",
    [string]$StateFile = "$env:ProgramData\anc\data\update-watch.state.json",
    [string]$InstallDir = "$env:LOCALAPPDATA\Programs\WorkBuddy"
)

$ErrorActionPreference = 'Continue'
$exe = Join-Path $InstallDir 'WorkBuddy.exe'
if (-not (Test-Path $exe)) { exit 2 }
$cur = (Get-Item $exe).VersionInfo.FileVersion

$url = "https://www.workbuddy.cn/v2/update?platform=$Platform&version=$cur"
$status = 0
$body = ''
try {
    $resp = Invoke-WebRequest -Uri $url -Method Get -TimeoutSec 20 -ErrorAction Stop
    $status = [int]$resp.StatusCode
    $body = $resp.Content
} catch {
    $status = $_.Exception.Response.StatusCode.value__
    if (-not $status) { Write-Host "network error: $($_.Exception.Message)"; exit 2 }
}

if ($status -eq 204) { Write-Host "no update (current $cur)"; exit 0 }
if ($status -ne 200) { Write-Host "unexpected status $status"; exit 2 }

# 有新版本：尽量从 JSON 取版本号
$new = ''
try {
    $j = $body | ConvertFrom-Json
    $new = ($j.version, $j.latestVersion, $j.tag, $j.name | Where-Object { $_ } | Select-Object -First 1)
} catch { }
if (-not $new) { $new = 'unknown' }

# 同一版本只告警一次
$seen = @()
if (Test-Path $StateFile) {
    try { $seen = @(Get-Content $StateFile -Raw -Encoding UTF8 | ConvertFrom-Json).seen } catch { $seen = @() }
}
if ($seen -contains $new) { Write-Host "already alerted for $new"; exit 0 }

if (Test-Path $WebhookFile) {
    try {
        $hook = (Get-Content $WebhookFile -Raw).Trim()
        if ($hook) {
            $msg = "[anc] WorkBuddy 有新版本：当前 $cur → $new。请按 docs/WORKBUDDY-PATCH.md 走三段回归（light/skills/anc-wb-patch）"
            $payload = @{ msgtype = 'text'; text = @{ content = $msg } } | ConvertTo-Json -Depth 4 -Compress
            Invoke-RestMethod -Uri $hook -Method Post -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($payload)) -TimeoutSec 15 | Out-Null
        }
    } catch { }
}

$seen += $new
[pscustomobject]@{ seen = $seen; at = (Get-Date).ToString('o') } | ConvertTo-Json |
    Set-Content $StateFile -Encoding utf8
Write-Host "new version $new (alerted)"
exit 0
