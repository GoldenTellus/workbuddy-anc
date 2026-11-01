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
    # 唯一的线上补丁来源：部署脚本复制到这里；不从 git 工作副本跑（切分支会改到线上）
    [string]$PatchDir = "$env:ProgramData\anc\patch",
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
    $workerStart = Get-Date
    # 先写 restarting：守卫在重启空档里看到它就不再重复拉起
    [IO.File]::WriteAllText($StateFile, ([pscustomobject]@{ at = $workerStart.ToString('o'); status = 'restarting' } | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
    Write-Log 'worker: 4 秒后重启 WorkBuddy'
    Start-Sleep -Seconds 4
    Get-Process WorkBuddy -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    for ($i = 0; $i -lt 30; $i++) {
        if (-not (Get-Process WorkBuddy -ErrorAction SilentlyContinue)) { break }
        Start-Sleep -Seconds 1
    }
    Write-Log 'worker: WorkBuddy 已全部退出'
    Start-Sleep -Seconds 4

    $launcher = Join-Path $PatchDir 'launch-patched.ps1'
    $out = "$env:ProgramData\anc\data\launcher.out"
    $cmdFile = "$env:ProgramData\anc\data\selfheal-launch.cmd"
    @"
@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "$launcher" > "$out" 2>&1
"@ | Set-Content $cmdFile -Encoding ascii

    # 只认本次启动之后由补丁体写下的 applied=true（旧日志行、拼接时的记录都不算）
    function Test-Patched {
        $ps = "$env:ProgramData\anc\data\patch-state.json"
        if (-not (Test-Path $ps)) { return $false }
        try {
            $s = [IO.File]::ReadAllText($ps, [Text.Encoding]::UTF8).TrimStart([char]0xFEFF) | ConvertFrom-Json
            return ([bool]$s.applied -and ([datetime]$s.at) -gt $workerStart)
        } catch { return $false }
    }

    $ok = $false
    for ($attempt = 1; $attempt -le 2 -and -not $ok; $attempt++) {
        Write-Log ("worker: 第 $attempt 次启动 " + $launcher)
        # 经 Explorer 启动：与人工双击/relaunch.cmd 的路径一致，避免直接 Start-Process 导致的提前退出
        $launchVbs = "$env:ProgramData\anc\data\selfheal-launch.vbs"
        @"
Set sh = CreateObject("WScript.Shell")
sh.Run """$cmdFile""", 0, False
"@ | Set-Content $launchVbs -Encoding ascii
        Start-Process explorer.exe -ArgumentList $launchVbs
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

    if ($ok) {
        Write-Log 'worker: 重启成功（补丁已生效）'
        [IO.File]::WriteAllText($StateFile, ([pscustomobject]@{ at = (Get-Date).ToString('o'); status = 'healed' } | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
    }
    else {
        Write-Log 'worker: 两次启动都没见到补丁日志'
        # 标成 restart-failed：守卫 60 分钟内不再触发，避免降级启动—再自愈的循环
        [IO.File]::WriteAllText($StateFile, ([pscustomobject]@{ at = (Get-Date).ToString('o'); status = 'restart-failed' } | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
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
function Write-State($obj) {
    [IO.File]::WriteAllText($StateFile, ($obj | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
}
function Read-State {
    if (-not (Test-Path $StateFile)) { return $null }
    try {
        $raw = [IO.File]::ReadAllText($StateFile, [Text.Encoding]::UTF8).TrimStart([char]0xFEFF)
        return ($raw | ConvertFrom-Json)
    } catch { return $null }
}

# 冷却（锚点缺失/inspect 失败也走同一份冷却，避免刷屏）
# 崩溃恢复优先：bot 根本没在跑时不受冷却限制，否则要干等 10 分钟
if (-not $Force) {
    $alive = Get-Process WorkBuddy -ErrorAction SilentlyContinue
    if (-not $alive) { $Force = $true; Write-Log 'no WorkBuddy process: bypass cooldown' }
}

$state = Read-State
if ($state -and $state.at -and -not $Force) {
    $mins = ((Get-Date) - [datetime]$state.at).TotalMinutes
    if ($mins -lt $CooldownMinutes) {
        Write-Log "cooldown: 上次自愈在 $([int]$mins) 分钟前，跳过"
        exit 0
    }
}

$inspect = & node (Join-Path $PatchDir 'inspect.mjs') 2>$null | Out-String
if (-not $inspect) {
    Write-Log 'ERROR inspect 没有输出（manifest 或 asar 有问题）'
    Write-State ([pscustomobject]@{ at = (Get-Date).ToString('o'); status = 'inspect-failed' })
    Send-Alert '补丁自愈无法执行：inspect 无输出（manifest/asar 可能损坏），需人工检查'
    exit 2
}
try { $r = $inspect | ConvertFrom-Json } catch { $r = $null }
if (-not $r -or -not $r.ok) {
    Write-Log 'ERROR inspect 返回失败'
    Write-State ([pscustomobject]@{ at = (Get-Date).ToString('o'); status = 'inspect-failed' })
    Send-Alert '补丁自愈无法执行：inspect 返回失败，需人工检查'
    exit 2
}
Write-Log ("inspect: version=$($r.version) hashMatches=$($r.hashMatches) anchorsOk=$($r.anchorsOk) bootstrapOk=$($r.bootstrapOk)")

if (-not $r.anchorsOk) {
    Write-Log '锚点缺失：需要人工（skill anc-wb-patch 的 B/C 分支）'
    # 写冷却，避免守卫每分钟重复告警
    Write-State ([pscustomobject]@{ at = (Get-Date).ToString('o'); status = 'anchors-missing'; version = $r.version })
    Send-Alert '补丁自愈失败：关键锚点缺失（emitMessage/WecomAiBotClient），需人工重找注入点；冷却期内不再重复告警'
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
Write-State ([pscustomobject]@{ at = (Get-Date).ToString('o'); version = $r.version; hashMatches = $r.hashMatches })

Write-Log '安排自愈重启（约 5 秒后 bot 短暂离线）'
$self = $MyInvocation.MyCommand.Path
$workerCmd = "$env:ProgramData\anc\data\selfheal-worker.cmd"
@"
@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "$self" -Worker -PatchDir "$PatchDir"
"@ | Set-Content $workerCmd -Encoding ascii
# 经 Explorer 拉起 Worker：脱离 WorkBuddy 的进程树；用 .vbs 包一层避免闪窗
$workerVbs = "$env:ProgramData\anc\data\selfheal-worker.vbs"
@"
Set sh = CreateObject("WScript.Shell")
sh.Run """$workerCmd""", 0, False
"@ | Set-Content $workerVbs -Encoding ascii
Start-Process explorer.exe -ArgumentList $workerVbs
exit 0
