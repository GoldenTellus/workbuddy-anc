# ANC WorkBuddy 补丁启动器：把群身份注入 agent 上下文
# 对应 FORK-DIRECTION §11 台账；目标版本与文件 hash 见同目录 manifest.json。
#
# 为什么不是直接设 NODE_OPTIONS：Electron 打包应用会丢弃大多数 NODE_OPTIONS
# （日志会打印 "Most NODE_OPTIONs are not supported in packaged apps"）。
# 所以这里用 --inspect-brk 暂停启动，由 inject.cjs 在主进程里设置环境变量，
# 再放行；daemon 随后继承该变量，加载 preload.cjs。
#
# 退出码：0 成功（含注入失败后降级启动） / 1 版本或注入失败 / 2 用法或环境错误

[CmdletBinding()]
param(
    [string]$InstallDir = "$env:LOCALAPPDATA\Programs\WorkBuddy",
    [int]$Port = 9229,
    [switch]$NoPatch
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$manifestPath = Join-Path $here 'manifest.json'
$preload = Join-Path $here 'preload.cjs'
$inject = Join-Path $here 'inject.cjs'
$patchLog = Join-Path $env:USERPROFILE 'anc\workbuddy-patch.log'

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

$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
$exe = Join-Path $InstallDir 'WorkBuddy.exe'
if (-not (Test-Path $exe)) { Fail "找不到 $exe" '用 -InstallDir 指向 WorkBuddy 安装目录' 2 }

$ver = (Get-Item $exe).VersionInfo.FileVersion
if ($ver -ne $manifest.workbuddyVersion) {
    # 版本不符：发运维告警（有 ops webhook 才发），然后按未打补丁方式启动
    $ops = Join-Path $env:ProgramData 'anc\secrets\ops-webhook.txt'
    if (Test-Path $ops) {
        try {
            $url = (Get-Content $ops -Raw).Trim()
            if ($url) {
                $body = (@{ msgtype = 'text'; text = @{ content = "[anc] WorkBuddy 升级到 $ver（登记版本 $($manifest.workbuddyVersion)），补丁未生效，请按 docs/WORKBUDDY-PATCH.md 重放" } } | ConvertTo-Json -Depth 4 -Compress)
                Invoke-RestMethod -Uri $url -Method Post -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 10 | Out-Null
                Write-Host '[anc] 已向运维群发送版本不符告警'
            }
        } catch { Write-Host "[anc] 告警发送失败: $($_.Exception.Message)" }
    }
    Fail "WorkBuddy 版本不符：期望 $($manifest.workbuddyVersion)，实际 $ver" '升级后先重测，再更新 manifest.json 的版本与 hash；本次按未打补丁启动' 1
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

# 1) 以 --inspect-brk 启动，进程会暂停等待调试器
Start-WorkBuddy $exe $InstallDir @("--inspect-brk=$Port")
Start-Sleep -Milliseconds 800

# 2) 连上去设环境变量并放行
Write-Host "[anc] 注入中（port=$Port）..."
& $node $inject --port $Port --preload $preload
$injectCode = $LASTEXITCODE

if ($injectCode -ne 0) {
    Write-Host "[anc] 注入失败（exit=$injectCode），降级为未打补丁启动"
    Get-Process WorkBuddy -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 3
    Start-WorkBuddy $exe $InstallDir @()
    exit 1
}

Write-Host "[anc] 已注入并放行；daemon 继承 NODE_OPTIONS 后会加载 preload.cjs"
Write-Host "[anc] 日志：$patchLog"
Write-Host "[anc] 已启动 WorkBuddy（版本 $ver，补丁模式）"
exit 0
