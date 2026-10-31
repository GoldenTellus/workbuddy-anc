# 补丁守卫：每分钟看一次——WorkBuddy 在跑但补丁记录对不上，就触发自愈
# 由计划任务 anc-patch-guard 调用（登录后每分钟，用户会话内，能拉起 GUI）
# 退出码：0 正常/已触发/没在跑
[CmdletBinding()]
param(
    [string]$StateFile = "$env:ProgramData\anc\data\patch-state.json",
    [string]$SelfHeal = "$env:ProgramData\anc\bin\anc-selfheal.ps1",
    [string]$Repo = 'E:\workbuddy-anc'
)

$ErrorActionPreference = 'Continue'

$main = Get-CimInstance Win32_Process -Filter "Name='WorkBuddy.exe'" |
    Where-Object { $_.CommandLine -notmatch '--type=' -and $_.CommandLine -notmatch 'daemon-app-server-entry' } |
    Select-Object -First 1
if (-not $main) { exit 0 }   # 没在跑：交给 anc-workbuddy-launch

$patched = $false
if (Test-Path $StateFile) {
    try {
        $s = Get-Content $StateFile -Raw | ConvertFrom-Json
        $at = [datetime]$s.at
        # 不比对 pid（加载模块的进程可能不是主进程），改看「补丁写入时间是否晚于进程启动」
        if ($at -ge $main.CreationDate.AddSeconds(-15)) { $patched = $true }
    } catch { }
}
if ($patched) { exit 0 }

# 在跑但没打补丁 → 自愈（内部有 10 分钟冷却）
& powershell -NoProfile -ExecutionPolicy Bypass -File $SelfHeal -Apply -Repo $Repo *> $null
exit 0
