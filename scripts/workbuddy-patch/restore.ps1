# ANC WorkBuddy 补丁回滚：结束进程，以未打补丁方式重新启动
# 退出码：0 成功 / 2 环境错误

[CmdletBinding()]
param(
    [string]$InstallDir = "$env:LOCALAPPDATA\Programs\WorkBuddy"
)

$ErrorActionPreference = 'Stop'

function Fail([string]$msg, [string]$fix, [int]$code) {
    Write-Host "ERROR $msg"
    Write-Host "FIX   $fix"
    exit $code
}

$exe = Join-Path $InstallDir 'WorkBuddy.exe'
if (-not (Test-Path $exe)) { Fail "找不到 $exe" '用 -InstallDir 指向 WorkBuddy 安装目录' 2 }

$procs = Get-Process WorkBuddy -ErrorAction SilentlyContinue
if ($procs) {
    Write-Host "[anc] 结束 WorkBuddy（$($procs.Count) 个进程）"
    $procs | Stop-Process -Force
    Start-Sleep -Seconds 4
}

Remove-Item Env:\NODE_OPTIONS -ErrorAction SilentlyContinue
Start-Process -FilePath $exe -WorkingDirectory $InstallDir
Write-Host '[anc] 已以未打补丁方式重启；补丁只存在于进程内存，重启即失效'
exit 0
