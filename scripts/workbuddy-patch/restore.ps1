# ANC WorkBuddy 补丁回滚：结束进程，以未打补丁方式重新启动
# 退出码：0 成功 / 2 环境错误

[CmdletBinding()]
param(
    [string]$InstallDir = "$env:LOCALAPPDATA\Programs\WorkBuddy",
    # 临时排障用：保持无补丁运行（写维护开关，守卫不会一分钟后把它重新打补丁）
    [switch]$StayUnpatched,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

function Fail([string]$msg, [string]$fix, [int]$code) {
    Write-Host "ERROR $msg"
    Write-Host "FIX   $fix"
    exit $code
}

$exe = Join-Path $InstallDir 'WorkBuddy.exe'
if (-not (Test-Path $exe)) { Fail "找不到 $exe" '用 -InstallDir 指向 WorkBuddy 安装目录' 2 }

if ($DryRun) {
    Write-Host "[anc] dry-run：将结束 WorkBuddy 并以无补丁方式启动 $exe"
    if ($StayUnpatched) { Write-Host '[anc] dry-run：将写 maintenance.flag' } else { Write-Host '[anc] 注意：守卫会在一分钟内重新打补丁；要停留无补丁请加 -StayUnpatched' }
    exit 0
}

$procs = Get-Process WorkBuddy -ErrorAction SilentlyContinue
if ($procs) {
    Write-Host "[anc] 结束 WorkBuddy（$($procs.Count) 个进程）"
    $procs | Stop-Process -Force
    Start-Sleep -Seconds 4
}

Remove-Item Env:\NODE_OPTIONS -ErrorAction SilentlyContinue
Start-Process -FilePath $exe -WorkingDirectory $InstallDir
if ($StayUnpatched) {
    $flag = "$env:ProgramData\anc\data\maintenance.flag"
    "restore.ps1 -StayUnpatched $(Get-Date -Format o)" | Set-Content $flag -Encoding utf8
    Write-Host "[anc] 已写维护开关：$flag（恢复打补丁前删除它）"
} else {
    Write-Host '[anc] 注意：anc-patch-guard 会在一分钟内重新打补丁；要停留无补丁请加 -StayUnpatched'
}
Write-Host '[anc] 已以未打补丁方式重启；补丁只存在于进程内存，重启即失效'
exit 0
