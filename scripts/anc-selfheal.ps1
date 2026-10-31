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
    [switch]$Force,
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

# 工作进程：等回复发出去 → 停掉 WorkBuddy → 用补丁启动器重启
# 注意：不能用 taskkill /T——Worker 自己是 WorkBuddy 的后代进程，/T 会把它一起杀掉。
if ($Worker) {
    Write-Log 'worker: 4 秒后重启 WorkBuddy'
    Start-Sleep -Seconds 4
    Get-Process WorkBuddy -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    for ($i = 0; $i -lt 30; $i++) {
        if (-not (Get-Process WorkBuddy -ErrorAction SilentlyContinue)) { break }
        Start-Sleep -Seconds 1
    }
    Write-Log 'worker: WorkBuddy 已全部退出'
    Start-Sleep -Seconds 4

    $launcher = Join-Path $Repo 'scripts\workbuddy-patch\launch-patched.ps1'
    $out = "$env:ProgramData\anc\data\launcher.out"
    $cmdFile = "$env:ProgramData\anc\data\selfheal-launch.cmd"
    @"
@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "$launcher" > "$out" 2>&1
"@ | Set-Content $cmdFile -Encoding ascii

    function Test-Patched {
        $plog = Join-Path $env:USERPROFILE 'anc\workbuddy-patch.log'
        if (-not (Test-Path $plog)) { return $false }
        return [bool](Get-Content $plog -Tail 60 | Select-String -Pattern 'PATCHED|ANCHOR-PATCH' -Quiet)
    }

    $ok = $false
    for ($attempt = 1; $attempt -le 2 -and -not $ok; $attempt++) {
        Write-Log ("worker: 第 $attempt 次启动 " + $launcher)
        # 经 Explorer 启动：与人工双击/relaunch.cmd 的路径一致，避免直接 Start-Process 导致的提前退出
        Start-Process explorer.exe -ArgumentList $cmdFile
        for ($i = 0; $i -lt 60; $i++) {
            Start-Sleep -Seconds 2
            if (Test-Patched) { $ok = $true; break }
            if (-not (Get-Process WorkBuddy -ErrorAction SilentlyContinue) -and $i -ge 10) { break }
        }
        if (-not $ok) {
            Write-Log ("worker: 第 $attempt 次未见补丁，清理后重试")
            Get-Process WorkBuddy -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 6
        }
    }

    if ($ok) { Write-Log 'worker: 重启成功（补丁已生效）' }
    else {
        Write-Log 'worker: 两次启动都没见到补丁日志'
        if (Test-Path $WebhookFile) {
            try {
                $url = (Get-Content $WebhookFile -Raw).Trim()
                if ($url) {
                    $body = @{ msgtype = 'text'; text = @{ content = '[anc] 自愈重启失败：两次都没见到补丁日志，请人工用 launch-patched.ps1 重启（输出见 launcher.out）' } } | ConvertTo-Json -Depth 4 -Compress
                    Invoke-RestMethod -Uri $url -Method Post -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 10 | Out-Null
                }
            } catch { }
        }
    }
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
if ($state.at -and -not $Force) {
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
$workerCmd = "$env:ProgramData\anc\data\selfheal-worker.cmd"
@"
@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "$self" -Worker -Repo "$Repo"
"@ | Set-Content $workerCmd -Encoding ascii
# 经 Explorer 拉起 Worker：脱离 WorkBuddy 的进程树，否则 WorkBuddy 退出时会被一起带走
Start-Process explorer.exe -ArgumentList $workerCmd
exit 0
