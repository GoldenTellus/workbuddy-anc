# 在 anc-bot 用户下跑一次：把暂存的 WorkBuddy 与补丁装到本用户，然后给出启动命令
# 用法（anc-bot 登录后）：powershell -NoProfile -ExecutionPolicy Bypass -File C:\ProgramData\anc\patch\setup-anc-bot.ps1
$ErrorActionPreference = 'Stop'

$stage = 'C:\ProgramData\anc\stage\WorkBuddy'
$dst = Join-Path $env:LOCALAPPDATA 'Programs\WorkBuddy'
$patchSrc = 'C:\ProgramData\anc\patch'
$patchDst = Join-Path $env:USERPROFILE 'anc\patch'
$skillsSrc = 'C:\ProgramData\anc\stage\skills'
$skillsDst = Join-Path $env:USERPROFILE '.workbuddy\skills'

if (-not (Test-Path (Join-Path $stage 'WorkBuddy.exe'))) {
    Write-Host "ERROR 暂存目录不完整: $stage" -ForegroundColor Red
    exit 2
}

Write-Host '[1/3] 复制 WorkBuddy ...'
robocopy $stage $dst /E /NFL /NDL /NJH /NJS /R:1 /W:1 | Out-Null

Write-Host '[2/3] 复制补丁 ...'
New-Item -ItemType Directory -Force -Path $patchDst | Out-Null
robocopy $patchSrc $patchDst /E /NFL /NDL /NJH /NJS /R:1 /W:1 | Out-Null

Write-Host '[3/3] 安装技能 ...'
if (Test-Path $skillsSrc) {
    New-Item -ItemType Directory -Force -Path $skillsDst | Out-Null
    robocopy $skillsSrc $skillsDst /E /NFL /NDL /NJH /NJS /R:1 /W:1 | Out-Null
}

Write-Host ''
Write-Host '完成。下一步：' -ForegroundColor Green
Write-Host ("  powershell -NoProfile -ExecutionPolicy Bypass -File `"" + (Join-Path $patchDst 'launch-patched.ps1') + "`"")
Write-Host '启动后扫码登录企业微信；确认 %USERPROFILE%\anc\workbuddy-patch.log 里有 PATCHED。'
exit 0
