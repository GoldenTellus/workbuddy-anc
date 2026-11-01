# 补丁守卫：每分钟看一次——WorkBuddy 在跑但补丁记录对不上，就触发自愈
# 由计划任务 anc-patch-guard 调用（登录后每分钟，用户会话内，能拉起 GUI）
# 退出码：0 正常/已触发/没在跑
[CmdletBinding()]
param(
    [string]$StateFile = "$env:ProgramData\anc\data\patch-state.json",
    [string]$SelfHeal = "$env:ProgramData\anc\bin\anc-selfheal.ps1",
    [string]$PatchDir = "$env:ProgramData\anc\patch"
)

$ErrorActionPreference = 'Continue'

# 维护开关：升级/排障期间停 WorkBuddy，guard 不许抢着拉起
$flag = "$env:ProgramData\anc\data\maintenance.flag"
if (Test-Path $flag) {
    $why = (Get-Content $flag -Raw -ErrorAction SilentlyContinue).Trim()
    Write-Host "maintenance flag present: $why"
    exit 0
}

$main = Get-CimInstance Win32_Process -Filter "Name='WorkBuddy.exe'" |
    Where-Object { $_.CommandLine -notmatch '--type=' -and $_.CommandLine -notmatch 'daemon-app-server-entry' } |
    Select-Object -First 1

# 没在跑（崩溃/维护后）：交给自愈拉起；guard 自己记上次拉起时间，10 分钟内不重复
$healState = "$env:ProgramData\anc\data\selfheal.state.json"
$hs = $null
if (Test-Path $healState) {
    try { $hs = [IO.File]::ReadAllText($healState, [Text.Encoding]::UTF8).TrimStart([char]0xFEFF) | ConvertFrom-Json } catch { $hs = $null }
}
# 自愈 Worker 正在重启（空档里没有主进程是正常的），5 分钟内不插手
if ($hs -and $hs.status -eq 'restarting' -and ((Get-Date) - [datetime]$hs.at).TotalMinutes -lt 5) { exit 0 }

if (-not $main) {
    $guardState = "$env:ProgramData\anc\data\patch-guard.state.json"
    $last = $null
    if (Test-Path $guardState) {
        try {
            $raw = [IO.File]::ReadAllText($guardState, [Text.Encoding]::UTF8).TrimStart([char]0xFEFF)
            $last = [datetime]($raw | ConvertFrom-Json).lastStartAt
        } catch { }
    }
    if ($last -and ((Get-Date) - $last).TotalMinutes -lt 3) { exit 0 }
    [pscustomobject]@{ lastStartAt = (Get-Date).ToString('o') } | ConvertTo-Json |
        Set-Content $guardState -Encoding utf8 -ErrorAction SilentlyContinue
    & powershell -NoProfile -ExecutionPolicy Bypass -File $SelfHeal -Apply -PatchDir $PatchDir *> $null
    exit 0
}

$patched = $false
if (Test-Path $StateFile) {
    try {
        $raw = [IO.File]::ReadAllText($StateFile, [Text.Encoding]::UTF8).TrimStart([char]0xFEFF)
        $s = $raw | ConvertFrom-Json
        $at = [datetime]$s.at
        # 只认补丁体包装成功后写下的 applied=true（注入了但没找到类的不算）
        $okMode = [bool]$s.applied
        if ($okMode -and $at -ge $main.CreationDate.AddSeconds(-15)) { $patched = $true }
    } catch { }
}
if ($patched) { exit 0 }

# 有人正在对话（canary 两分钟内有更新）就别打断：等下一分钟的空档再重启
$canaryFile = "$env:ProgramData\anc\data\patch-canary.json"
if (Test-Path $canaryFile) {
    try {
        $c = [IO.File]::ReadAllText($canaryFile, [Text.Encoding]::UTF8).TrimStart([char]0xFEFF) | ConvertFrom-Json
        if (((Get-Date) - [datetime]$c.at).TotalMinutes -lt 2) {
            Write-Host 'canary active recently: defer restart'
            exit 0
        }
    } catch { }
}

# 自愈已判定「修不了」（锚点缺失/inspect 失败）时别每分钟再拉一次进程
if ($hs) {
    $blocked = ($hs.status -eq 'anchors-missing' -or $hs.status -eq 'inspect-failed' -or $hs.status -eq 'restart-failed')
    if ($blocked -and ((Get-Date) - [datetime]$hs.at).TotalMinutes -lt 60) { exit 0 }
}

# 在跑但没打补丁 → 自愈（内部有 10 分钟冷却）
& powershell -NoProfile -ExecutionPolicy Bypass -File $SelfHeal -Apply -PatchDir $PatchDir *> $null
exit 0
