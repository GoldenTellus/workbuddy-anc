# ANC WorkBuddy 补丁启动器：把群身份注入 agent 上下文
# 对应 FORK-DIRECTION §11 台账；目标版本与文件 hash 见同目录 manifest.json。
#
# 注入方式（2026-11-05 两条路都实测过，见 VERIFY §59）：
#
#   默认 --inspect-brk —— 暂停启动 → inject.cjs 在主进程里设 process.env.NODE_OPTIONS → 放行；
#     daemon 子进程（child_process.fork）继承 process.env，加载 preload.cjs。
#     这是**唯一可行**的路径：实测能成功（APPLIED mode=hash），但同一份脚本时好时坏 ——
#     失败时 WorkBuddy 进程消失、事件日志留 0xc0000005。注入后的轮询会把这种失败暴露出来。
#
#   NODE_OPTIONS（ANC_WB_METHOD=env，实测不可用，仅留作对照）—— 直接给进程设 NODE_OPTIONS。
#     Electron 会丢弃：stderr 明确打 "Most NODE_OPTIONs are not supported in packaged apps"。
#     表现是主进程正常起来（7 个进程）但补丁从不加载（patch-state 不写）。
#     2026-11-05 曾短暂把它改成默认，因为观察到一次 applied=true —— 那是残留进程偶然继承了变量，
#     不是这条路能用。已改回。
#
# 退出码：0 成功 / 1 版本或注入失败（**含「补丁没装上、已无补丁降级启动」**，降级不等于成功，
#          调用方仍要按失败处理） / 2 用法或环境错误 / 4 manifest.json 损坏或字段缺失

[CmdletBinding()]
param(
    [string]$InstallDir = "$env:LOCALAPPDATA\Programs\WorkBuddy",
    [int]$Port = 9229,
    [switch]$NoPatch,
    # 默认按结构锚点打补丁（版本变化也继续）；-Strict 时版本不符则拒绝启动
    [switch]$Strict,
    # 状态目录做成参数：便于在临时目录验证注入判定，不碰在跑的部署
    [string]$StateDir = "$env:ProgramData\anc\data",
    [int]$WaitTimeoutSec = 150
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$manifestPath = Join-Path $here 'manifest.json'
$preload = Join-Path $here 'preload.cjs'
$inject = Join-Path $here 'inject.cjs'
$patchLog = Join-Path $env:USERPROFILE 'anc\workbuddy-patch.log'
$patchLogDir = Split-Path -Parent $patchLog
if (-not (Test-Path -LiteralPath $patchLogDir)) { New-Item -ItemType Directory -Force -Path $patchLogDir | Out-Null }

function Fail([string]$msg, [string]$fix, [int]$code) {
    Write-Host "ERROR $msg"
    Write-Host "FIX   $fix"
    exit $code
}

function Start-WorkBuddy([string]$exe, [string]$workDir, [string[]]$arguments) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $exe
    $psi.WorkingDirectory = $workDir
    $psi.UseShellExecute = $false
    if ($arguments) { $psi.Arguments = ($arguments -join ' ') }
    [void][System.Diagnostics.Process]::Start($psi)
}

function Find-Node {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $bundled = Get-ChildItem (Join-Path $env:USERPROFILE '.workbuddy\binaries\node\versions') -Recurse -Filter node.exe -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($bundled) { return $bundled.FullName }
    return $null
}

if (-not (Test-Path $manifestPath)) { Fail 'manifest.json 不存在' '确认 scripts/workbuddy-patch/ 完整' 2 }
if (-not (Test-Path $preload)) { Fail 'preload.cjs 不存在' '确认 scripts/workbuddy-patch/ 完整' 2 }
if (-not (Test-Path $inject)) { Fail 'inject.cjs 不存在' '确认 scripts/workbuddy-patch/ 完整' 2 }

$manifest = $null
try {
    $manifest = Get-Content $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
} catch {
    # manifest 坏了就 fail-closed：否则带着错的 hash 启动只会让补丁静默失效
    $ops = Join-Path $env:ProgramData 'anc\secrets\ops-webhook.txt'
    if (Test-Path $ops) {
        try {
            $url = (Get-Content $ops -Raw).Trim()
            if ($url) {
                $body = (@{ msgtype = 'text'; text = @{ content = "[anc] manifest.json 无法解析，补丁启动被拒绝：$($_.Exception.Message)。请从 git 恢复 scripts/workbuddy-patch/manifest.json" } } | ConvertTo-Json -Depth 4 -Compress)
                Invoke-RestMethod -Uri $url -Method Post -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 10 | Out-Null
            }
        } catch { }
    }
    Fail "manifest.json 无法解析：$($_.Exception.Message)" '从 git 恢复 scripts/workbuddy-patch/manifest.json；或用 -NoPatch 临时启动' 4
}
if (-not $manifest.workbuddyVersion -or -not $manifest.sha256) {
    Fail 'manifest.json 缺少 workbuddyVersion / sha256' '从 git 恢复 manifest.json' 4
}
$exe = Join-Path $InstallDir 'WorkBuddy.exe'
if (-not (Test-Path $exe)) { Fail "找不到 $exe" '用 -InstallDir 指向 WorkBuddy 安装目录' 2 }

$ver = (Get-Item $exe).VersionInfo.FileVersion
if ($ver -ne $manifest.workbuddyVersion) {
    # 版本不符：默认进入锚点模式（照打补丁），只告警；-Strict 时 fail-closed
    $ops = Join-Path $env:ProgramData 'anc\secrets\ops-webhook.txt'
    if (Test-Path $ops) {
        try {
            $url = (Get-Content $ops -Raw).Trim()
            if ($url) {
                $mode = if ($Strict) { '严格模式：拒绝启动' } else { '锚点模式：继续打补丁' }
                $body = (@{ msgtype = 'text'; text = @{ content = "[anc] WorkBuddy 升级到 $ver（登记版本 $($manifest.workbuddyVersion)），$mode。请在测试群回归后更新 manifest" } } | ConvertTo-Json -Depth 4 -Compress)
                Invoke-RestMethod -Uri $url -Method Post -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 10 | Out-Null
                Write-Host '[anc] 已向运维群发送版本变化告警'
            }
        } catch { Write-Host "[anc] 告警发送失败: $($_.Exception.Message)" }
    }
    if ($Strict) {
        Fail "WorkBuddy 版本不符：期望 $($manifest.workbuddyVersion)，实际 $ver" '升级后先重测，再更新 manifest.json；本次按未打补丁启动' 1
    }
    Write-Host "[anc] 版本未登记（$ver），按结构锚点继续；回归通过后请更新 manifest"
    $env:ANC_WB_ANCHOR = '1'
}

if ($NoPatch -or $env:ANC_WB_PATCH -eq '0') {
    Write-Host '[anc] 以未打补丁方式启动'
    Start-WorkBuddy $exe $InstallDir @()
    Write-Host "[anc] 已启动 WorkBuddy（版本 $ver，未打补丁）"
    exit 0
}

$node = Find-Node
if (-not $node) { Fail '找不到 node.exe（系统 PATH 与 WorkBuddy 自带都没有）' '安装 Node 22+，或确认 %USERPROFILE%\.workbuddy\binaries\node 下存在 node.exe' 2 }

# NODE_OPTIONS 不做引号解析，preload 路径里不能有空白
if ($preload -match '\s') {
    Fail "preload 路径含空白：$preload" '把 scripts/workbuddy-patch 整个复制到不含空格的路径（例如 C:\anc\workbuddy-patch）后从那里运行' 2
}

# 对照路径：NODE_OPTIONS（ANC_WB_METHOD=env）。实测 Electron 丢弃，不可用，见文件头。
if ($env:ANC_WB_METHOD -eq 'env') {
    Get-Process WorkBuddy -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 2
    $env:NODE_OPTIONS = '--require ' + $preload
    Write-Host "[anc] NODE_OPTIONS = $env:NODE_OPTIONS（对照路径：Electron 会丢弃它）"
    Start-WorkBuddy $exe $InstallDir @()
    Write-Host '[anc] 已启动（NODE_OPTIONS 对照路径）'
    exit 0
}

# 默认路径：--inspect-brk（唯一可行，见文件头）

# 2026-11-06 修（VERIFY §58.7 / §61）：给本次启动一个唯一 runId。
# 旧 poll 只看 applied + pid，而 patch-state.json 在注入失败时**根本不会被改写**，
# 上一次成功留下的 applied=true 会让启动器立刻宣布成功（实测 2 小时前的陈旧状态
# 被判成功）。preload.cjs 的 writeState 会把这个 runId 写进 state，等待脚本据此判别。
$runId = [guid]::NewGuid().ToString('N')
$startedAt = Get-Date
$runFile = Join-Path $StateDir 'patch-run.json'
try {
    if (-not (Test-Path $StateDir)) { New-Item -ItemType Directory -Force -Path $StateDir | Out-Null }
    $runObj = [ordered]@{ runId = $runId; startedAt = $startedAt.ToUniversalTime().ToString('o'); launcherPid = $PID }
    [IO.File]::WriteAllText($runFile, ($runObj | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
} catch { Write-Host "[anc] 写 patch-run.json 失败：$($_.Exception.Message)（本次将无法用 runId 区分陈旧状态）" }

# 默认路径：以 --inspect-brk 启动，进程会暂停等待调试器
Start-WorkBuddy $exe $InstallDir @("--inspect-brk=$Port")

# 2026-11-05 修正：原来固定 Start-Sleep 800ms 就去连，连不上就当失败。
# 实测 inspector 就绪时间不固定，改成轮询（最多 40 秒）。
$inspectorReady = $false
for ($i = 0; $i -lt 80; $i++) {
    Start-Sleep -Milliseconds 500
    try {
        $probe = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/json/list" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
        if ($probe.Content -match 'webSocketDebuggerUrl') { $inspectorReady = $true; break }
    } catch { }
}
if (-not $inspectorReady) {
    Write-Host "[anc] inspector $Port 在 40 秒内没就绪"
    Get-Process WorkBuddy -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 3
    Start-WorkBuddy $exe $InstallDir @()
    exit 1
}

# 2) 连上去设环境变量并放行
Write-Host "[anc] 注入中（port=$Port）..."
& $node $inject --port $Port --preload $preload
$injectCode = $LASTEXITCODE

if ($injectCode -ne 0) {
    Write-Host "[anc] 注入失败（exit=$injectCode），降级为未打补丁启动"
    $ops = Join-Path $env:ProgramData 'anc\secrets\ops-webhook.txt'
    if (Test-Path $ops) {
        try {
            $url = (Get-Content $ops -Raw).Trim()
            if ($url) {
                $body = (@{ msgtype = 'text'; text = @{ content = "[anc] 补丁注入失败（inject exit=$injectCode），已降级为无补丁启动；群身份不可用，请查看 workbuddy-patch.log" } } | ConvertTo-Json -Depth 4 -Compress)
                Invoke-RestMethod -Uri $url -Method Post -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 10 | Out-Null
            }
        } catch { }
    }
    Get-Process WorkBuddy -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 3
    Start-WorkBuddy $exe $InstallDir @()
    exit 1
}

Write-Host "[anc] 已注入并放行；daemon 继承 NODE_OPTIONS 后会加载 preload.cjs"
Write-Host "[anc] 日志：$patchLog"

# 2026-11-06 修（VERIFY §58.7-2 / §61）：注入后必须等**本次启动**的确认。
# 保留 §59 的 150 秒等待（从放行到 APPLIED 实测约 60 秒），但换掉判据：
# 由 wait-patch-state.ps1 校验 runId / 时间窗 / pid，超时明确报「注入没成功」，
# 不再留「不要直接判失败，去看日志」那种要靠人猜的含糊结论。
$stateFile = Join-Path $StateDir 'patch-state.json'
$waiter = Join-Path $here 'wait-patch-state.ps1'
if (-not (Test-Path $waiter)) { Fail 'wait-patch-state.ps1 不存在' '确认 scripts/workbuddy-patch/ 完整' 2 }
& powershell -NoProfile -ExecutionPolicy Bypass -File $waiter `
    -StateFile $stateFile -RunId $runId -StartedAt $startedAt.ToString('o') `
    -TimeoutSec $WaitTimeoutSec -PatchLog $patchLog
$waitCode = $LASTEXITCODE
if ($waitCode -ne 0) {
    # 失败也要留下可判信号：别让 doctor / patch-guard 继续读到上一次的成功状态。
    # 与 anc-selfheal.ps1 失败回写 applied=false 是同一条规矩。
    try {
        $failObj = [ordered]@{
            applied = $false
            mode    = 'launch-timeout'
            pid     = 0
            at      = (Get-Date).ToUniversalTime().ToString('o')
            runId   = $runId
            error   = '启动器等待 patch-state 超时：本次注入没成功（群身份不可用）'
        }
        [IO.File]::WriteAllText($stateFile, ($failObj | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
    } catch { Write-Host "[anc] 回写失败状态出错: $($_.Exception.Message)" }
    exit 1
}
Write-Host "[anc] 已启动 WorkBuddy（版本 $ver，补丁模式）"
exit 0
