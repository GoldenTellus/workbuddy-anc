# 在 anc-bot 用户下跑一次：把暂存的 WorkBuddy 装到本用户，并安装技能
# 补丁不复制到用户目录：线上只从 C:\ProgramData\anc\patch 跑（OPS「补丁的唯一来源」）
# 用法（anc-bot 登录后）：powershell -NoProfile -ExecutionPolicy Bypass -File C:\ProgramData\anc\patch\setup-anc-bot.ps1
$ErrorActionPreference = 'Stop'

$stage = 'C:\ProgramData\anc\stage\WorkBuddy'
$dst = Join-Path $env:LOCALAPPDATA 'Programs\WorkBuddy'
$patchDir = 'C:\ProgramData\anc\patch'
$skillsSrc = 'C:\ProgramData\anc\stage\skills'
$skillsDst = Join-Path $env:USERPROFILE '.workbuddy\skills'

if (-not (Test-Path (Join-Path $stage 'WorkBuddy.exe'))) {
    Write-Host "ERROR 暂存目录不完整: $stage" -ForegroundColor Red
    Write-Host 'FIX   先把 WorkBuddy 装到暂存目录，或直接用官方安装包装到本用户'
    exit 2
}
if (-not (Test-Path (Join-Path $patchDir 'launch-patched.ps1'))) {
    Write-Host "ERROR 补丁目录不完整: $patchDir" -ForegroundColor Red
    Write-Host 'FIX   管理员跑 scripts\deploy.ps1 -Apply，把补丁部署到 %ProgramData%\anc\patch'
    exit 2
}

# robocopy 的退出码 0–7 是成功（1 表示有文件被复制），>=8 才是失败
function Copy-Tree([string]$from, [string]$to, [string]$label) {
    robocopy $from $to /E /NFL /NDL /NJH /NJS /R:1 /W:1 | Out-Null
    $code = $LASTEXITCODE
    if ($code -ge 8) {
        Write-Host "ERROR $label 复制失败（robocopy=$code）: $from -> $to" -ForegroundColor Red
        exit 3
    }
}

Write-Host '[1/2] 复制 WorkBuddy ...'
Copy-Tree $stage $dst 'WorkBuddy'

Write-Host '[2/2] 安装技能 ...'
if (Test-Path $skillsSrc) {
    New-Item -ItemType Directory -Force -Path $skillsDst | Out-Null
    Copy-Tree $skillsSrc $skillsDst 'skills'
}

Write-Host ''
Write-Host '完成。下一步：' -ForegroundColor Green
Write-Host ("  powershell -NoProfile -ExecutionPolicy Bypass -File `"" + (Join-Path $patchDir 'launch-patched.ps1') + "`"")
Write-Host '启动后扫码登录企业微信；确认 %USERPROFILE%\anc\workbuddy-patch.log 里有 APPLIED。'
Write-Host '注意：补丁只从 C:\ProgramData\anc\patch 跑，不再复制到 %USERPROFILE%\anc\patch。'
exit 0