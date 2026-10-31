# 补丁自愈：检查补丁是否生效；锚点还在就安排一次自我重启；锚点没了就告警
# 用法：
#   powershell -File anc-selfheal.ps1 -DryRun     # 只看结论，不动
#   powershell -File anc-selfheal.ps1 -Apply      # 安排重启（约 5 秒后 bot 会短暂离线）
# 退出码：0 已生效/已安排/冷却中；3 锚点缺失（需人工，走 skill B/C）；2 环境错误
[CmdletBinding()]
param(
    [switch]$Apply,
    [switch]$DryRun,
    [switch]$Worker,
    [int]$CooldownMinutes = 10,
    [string]$Repo = 'E:\workbuddy-anc',
    [string]$StateFile = "$env:ProgramData\anc\data\selfheal.state.json",
    [string]$WebhookFile = "$env:ProgramData\anc\secrets\ops-webhook.txt"
)

$ErrorActionPreference = 'Continue'
$log = "$env:ProgramData\anc\data\selfheal.log"
function Write-Log([string]$m) {
    $line = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $m
    Add-Content -Path $log -Value $line -Encoding utf8 -ErrorAction SilentlyContinue
    Write-Host $line
}

# 工作进程：等回复发出去 → 杀掉当前 WorkBuddy → 用补丁启动器重启
if ($Worker) {
    Write-Log 'worker: 4 秒后重启 WorkBuddy'
    Start-Sleep -Seconds 4
    $main = Get-CimInstance Win32_Process -Filter "Name='WorkBuddy.exe'" | Where-Object { $_.CommandLine -notmatch '--type=' -and $_.CommandLine -notmatch 'daemon-app-server-entry' } | Select-Object -First 1
    if ($main) { & taskkill /PID $main.ProcessId /T /F 2>&1 | Out-Null }
    Start-Sleep -Seconds 6
    $launcher = Join-Path $Repo 'scripts\workbuddy-patch\launch-patched.ps1'
    Write-Log ("worker: 启动 " + $launcher)
    Start-Process powershell -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $launcher) -WindowStyle Hidden
    exit 0
}

function Send-Alert([string]$text) {
    if (-not (Test-Path $WebhookFile)) { return }
    try {
        $url = (Get-Content $WebhookFile -Raw).Trim()
        if (-not $url) { return }
        $body = @{ msgtype = 'text'; text = @{ content = "[anc] $text" } } | ConvertTo-Json -Depth 4 -Compress
        Invoke-RestMethod -Uri $url -Method Post -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 10 | Out-Null
    } catch { }
}

# 冷却
$state = @{}
if (Test-Path $StateFile) { try { $state = Get-Content $StateFile -Raw | ConvertFrom-Json -AsHashtable } catch { $state = @{} } }
if ($state.at) {
    $mins = ((Get-Date) - [datetime]$state.at).TotalMinutes
    if ($mins -lt $CooldownMinutes) {
        Write-Log "cooldown: 上次自愈在 $([int]$mins) 分钟前，跳过"
        exit 0
    }
}

$inspect = & node (Join-Path $Repo 'scripts\workbuddy-patch\inspect.mjs') 2>$null | Out-String
if (-not $inspect) { Write-Log 'ERROR inspect 没有输出'; exit 2 }
$r = $inspect | ConvertFrom-Json
Write-Log ("inspect: version=$($r.version) hashMatches=$($r.hashMatches) anchorsOk=$($r.anchorsOk) bootstrapOk=$($r.bootstrapOk)")

if (-not $r.anchorsOk) {
    Write-Log '锚点缺失：需要人工（skill anc-wb-patch 的 B/C 分支）'
    Send-Alert '补丁自愈失败：关键锚点缺失，需人工重找注入点（skill anc-wb-patch）'
    exit 3
}

if ($r.hashMatches -and $r.anchorsOk) {
    # hash 对得上说明补丁本来就该生效；若到达这里多半是启动方式不对（没用启动器）
    Write-Log 'hash 匹配；若仍无前缀，检查是否用 launch-patched.ps1 启动'
}

if ($DryRun -or -not $Apply) {
    Write-Log 'dry-run：锚点可用，未安排重启'
    exit 0
}

# 记录并安排重启
[pscustomobject]@{ at = (Get-Date).ToString('o'); version = $r.version; hashMatches = $r.hashMatches } |
    ConvertTo-Json | Set-Content $StateFile -Encoding utf8

Write-Log '安排自愈重启（约 5 秒后 bot 短暂离线）'
$self = $MyInvocation.MyCommand.Path
Start-Process powershell -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $self, '-Worker', '-Repo', $Repo) -WindowStyle Hidden
exit 0
