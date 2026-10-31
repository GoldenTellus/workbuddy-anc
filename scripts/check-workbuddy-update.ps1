# 主动查 WorkBuddy 新版：204=无新版；200=有新版，发运维群（同一版本只告警一次）
# 计划任务 anc-update-watch 以 LOCAL SERVICE 运行，因此靠 workbuddy-path.txt 定位安装目录
[CmdletBinding()]
param(
    [string]$Platform = 'workbuddy-win32-x64-user',
    [string]$WebhookFile = "$env:ProgramData\anc\secrets\ops-webhook.txt",
    [string]$StateFile = "$env:ProgramData\anc\data\update-watch.state.json",
    [string]$LogFile = "$env:ProgramData\anc\data\update-watch.log",
    [string]$InstallDir = ''
)

$ErrorActionPreference = 'Continue'

function Write-Log([string]$m) {
    $line = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $m
    Add-Content -Path $LogFile -Value $line -Encoding utf8 -ErrorAction SilentlyContinue
    Write-Host $line
}

function Find-InstallDir {
    if ($InstallDir) { return $InstallDir }
    $marker = "$env:ProgramData\anc\data\workbuddy-path.txt"
    if (Test-Path $marker) {
        $p = (Get-Content $marker -Raw -Encoding UTF8).Trim()
        if ($p -and (Test-Path $p)) { return (Split-Path $p -Parent) }
    }
    $candidates = @()
    if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA 'Programs\WorkBuddy') }
    if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles 'WorkBuddy') }
    $candidates += (Get-ChildItem 'C:\Users\*\AppData\Local\Programs\WorkBuddy' -Directory -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
    foreach ($c in $candidates) {
        if ($c -and (Test-Path (Join-Path $c 'WorkBuddy.exe'))) { return $c }
    }
    return $null
}

$dir = Find-InstallDir
if (-not $dir) {
    Write-Log 'ERROR cannot locate WorkBuddy install dir (use -InstallDir)'
    exit 2
}

$exe = Join-Path $dir 'WorkBuddy.exe'
$cur = (Get-Item $exe).VersionInfo.FileVersion
Write-Log "checking platform=$Platform current=$cur dir=$dir"

$url = "https://www.workbuddy.cn/v2/update?platform=$Platform&version=$cur"
$status = 0
$body = ''
try {
    $resp = Invoke-WebRequest -Uri $url -Method Get -TimeoutSec 20 -ErrorAction Stop
    $status = [int]$resp.StatusCode
    $body = $resp.Content
} catch {
    $status = $_.Exception.Response.StatusCode.value__
    if (-not $status) { Write-Log "network error: $($_.Exception.Message)"; exit 2 }
}

if ($status -eq 204) { Write-Log "no update (current $cur)"; exit 0 }
if ($status -ne 200) { Write-Log "unexpected status $status"; exit 2 }

$new = ''
try {
    $j = $body | ConvertFrom-Json
    $new = ($j.version, $j.latestVersion, $j.tag, $j.name | Where-Object { $_ } | Select-Object -First 1)
} catch { }
if (-not $new) { $new = 'unknown' }

$seen = @()
if (Test-Path $StateFile) {
    try {
        $raw = [IO.File]::ReadAllText($StateFile, [Text.Encoding]::UTF8).TrimStart([char]0xFEFF)
        $seen = @(($raw | ConvertFrom-Json).seen)
    } catch { $seen = @() }
}
if ($seen -contains $new) { Write-Log "already alerted for $new"; exit 0 }

if (Test-Path $WebhookFile) {
    try {
        $hook = (Get-Content $WebhookFile -Raw).Trim()
        if ($hook) {
            $msg = "[anc] WorkBuddy 有新版本：当前 $cur -> $new。请按 docs/WORKBUDDY-PATCH.md 走三段回归（light/skills/anc-wb-patch）"
            $payload = @{ msgtype = 'text'; text = @{ content = $msg } } | ConvertTo-Json -Depth 4 -Compress
            Invoke-RestMethod -Uri $hook -Method Post -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($payload)) -TimeoutSec 15 | Out-Null
            Write-Log "alerted $new"
        }
    } catch { Write-Log "alert failed: $($_.Exception.Message)" }
}

$seen += $new
[pscustomobject]@{ seen = $seen; at = (Get-Date).ToString('o') } | ConvertTo-Json |
    Set-Content $StateFile -Encoding utf8 -ErrorAction SilentlyContinue
exit 0
