# 注册/修复 8 个计划任务（OPS.md「计划任务」表的可执行版本）
# 默认 dry-run；-Apply 才落盘。已存在同名任务会被覆盖（Register-ScheduledTask -Force）。
#
# 注意：两个交互类任务（anc-workbuddy-launch / anc-patch-guard）的 principal 是 -BotUser，
# 只有该用户登录过、装好 WorkBuddy 之后才有意义。在 R1 迁移完成前跑 -Apply 会把它们
# 从 Administrator 改到 anc-bot，导致守卫与启动器不工作；所以默认 BotUser 只用于“显示计划”，
# 真正落盘前会二次确认。
#
# 退出码：0 成功（含 dry-run）/ 1 校验失败 / 2 用法或环境错误
[CmdletBinding()]
param(
    [string]$BotUser = 'anc-bot',
    [string]$Root = '',
    [string]$ServiceAccount = 'LOCAL SERVICE',
    [string]$CleanupMediaDir = '',
    [string]$BackupDestination = 'E:\anc-backup',
    [switch]$Apply,
    [switch]$ForceInteractive
)

$ErrorActionPreference = 'Stop'
if (-not $Root) { $Root = Join-Path $env:ProgramData 'anc' }
if (-not $CleanupMediaDir) { $CleanupMediaDir = "C:\Users\$BotUser\AppData\Local\Temp\workbuddy-wecom-media" }
$bin = Join-Path $Root 'bin'

function Fail([string]$msg, [string]$fix, [int]$code) {
    Write-Host "ERROR $msg"
    Write-Host "FIX   $fix"
    exit $code
}

if (-not (Test-Path $bin)) { Fail "找不到 $bin" '先跑 scripts\deploy.ps1 -Apply 部署脚本' 2 }
foreach ($need in 'anc-loop.cmd', 'anc-launch.cmd', 'anc-guard.cmd', 'run-hidden.vbs') {
    if (-not (Test-Path (Join-Path $bin $need))) { Fail "缺少 $bin\$need" '先跑 scripts\deploy.ps1 -Apply' 2 }
}

function New-PsAction([string]$script, [string]$extra = '') {
    $arg = '-NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $bin $script) + '"'
    if ($extra) { $arg = $arg + ' ' + $extra }
    return New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arg
}
function New-HiddenAction([string]$cmd) {
    return New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('//B //Nologo "' + (Join-Path $bin 'run-hidden.vbs') + '" "' + (Join-Path $bin $cmd) + '"')
}
function New-EveryMinutesTrigger([int]$minutes, [string]$at = '00:00') {
    $t = New-ScheduledTaskTrigger -Daily -At $at
    $t.Repetition = (New-ScheduledTaskTrigger -Once -At $at -RepetitionInterval (New-TimeSpan -Minutes $minutes) -RepetitionDuration (New-TimeSpan -Days 9999)).Repetition
    return $t
}
function New-BootEveryTrigger([int]$minutes, [int]$hours) {
    $t = New-ScheduledTaskTrigger -AtStartup
    $t.Repetition = (New-ScheduledTaskTrigger -Once -At '00:00' -RepetitionInterval (New-TimeSpan -Minutes $minutes) -RepetitionDuration (New-TimeSpan -Hours $hours)).Repetition
    return $t
}
function New-Settings([string]$limit) {
    # 默认即 DisallowStartIfOnBatteries=True / StopIfGoingOnBatteries=True（与主机现状一致），不用显式传
    return New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable `
        -ExecutionTimeLimit (New-TimeSpan -Minutes ([int]($limit -replace 'PT|M', '')))
}

function New-ServicePrincipal([string]$user, [string]$level = 'Limited') {
    return New-ScheduledTaskPrincipal -UserId $user -LogonType ServiceAccount -RunLevel $level
}
function New-InteractivePrincipal([string]$user) {
    return New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
}

# 任务定义（与 OPS.md 的表一一对应）
$defs = @(
    @{
        Name = 'anc-service'; Desc = '本地小服务：每分钟一次 tick'
        Triggers = @((New-EveryMinutesTrigger 1), (New-ScheduledTaskTrigger -AtStartup))
        Action = (New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ('/c "' + (Join-Path $bin 'anc-loop.cmd') + '"'))
        Principal = (New-ServicePrincipal $ServiceAccount)
        Settings = (New-Settings 'PT2M')
    },
    @{
        Name = 'anc-backup'; Desc = 'SQLite + vault 备份（每天 02:00 起每小时，幂等）'
        Triggers = @((New-EveryMinutesTrigger 60 '02:00'))
        Action = (New-PsAction 'backup-anc.ps1' ('-Destination "' + $BackupDestination + '"'))
        Principal = (New-ServicePrincipal $ServiceAccount)
        Settings = (New-Settings 'PT10M')
    },
    @{
        Name = 'anc-boot-alert'; Desc = '开机后 WorkBuddy 没起来就告警（每 10 分钟，持续 2 小时）'
        Triggers = @((New-BootEveryTrigger 10 2))
        Action = (New-PsAction 'boot-alert.ps1')
        Principal = (New-ServicePrincipal $ServiceAccount)
        Settings = (New-Settings 'PT5M')
    },
    @{
        Name = 'anc-cleanup'; Desc = '清企微附件（每天 03:00）'
        Triggers = @((New-ScheduledTaskTrigger -Daily -At '03:00'))
        Action = (New-PsAction 'cleanup-media.ps1' ('-MediaDir "' + $CleanupMediaDir + '" -Days 7'))
        Principal = (New-ServicePrincipal 'SYSTEM' 'Highest')
        Settings = (New-Settings 'PT10M')
    },
    @{
        Name = 'anc-watchdog'; Desc = '心跳/积压/进程告警（每 10 分钟）'
        Triggers = @((New-EveryMinutesTrigger 10))
        Action = (New-PsAction 'watchdog.ps1')
        Principal = (New-ServicePrincipal $ServiceAccount)
        Settings = (New-Settings 'PT5M')
    },
    @{
        Name = 'anc-workbuddy-launch'; Desc = '登录 30 秒后用补丁启动器拉起 WorkBuddy（交互）'
        Triggers = @((New-ScheduledTaskTrigger -AtLogOn -User $BotUser))
        Action = (New-HiddenAction 'anc-launch.cmd')
        Principal = (New-InteractivePrincipal $BotUser)
        Settings = (New-Settings 'PT3M')
    },
    @{
        Name = 'anc-patch-guard'; Desc = '补丁守卫：每分钟看 applied=false 就自愈（交互）'
        Triggers = @(
            (New-ScheduledTaskTrigger -AtLogOn -User $BotUser),
            (New-ScheduledTaskTrigger -AtStartup),
            (New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration (New-TimeSpan -Days 9999))
        )
        Action = (New-HiddenAction 'anc-guard.cmd')
        Principal = (New-InteractivePrincipal $BotUser)
        Settings = (New-Settings 'PT3M')
    },
    @{
        Name = 'anc-update-watch'; Desc = '每天 09:00 查厂商更新接口，有新版本发运维群'
        Triggers = @((New-ScheduledTaskTrigger -Daily -At '09:00'))
        Action = (New-PsAction 'check-workbuddy-update.ps1')
        Principal = (New-ServicePrincipal $ServiceAccount)
        Settings = (New-Settings 'PT5M')
    }
)

# 计划摘要
'{0,-24} {1,-34} {2}' -f 'TASK', 'PRINCIPAL', 'ACTION'
foreach ($d in $defs) {
    $who = $d.Principal.UserId + '/' + $d.Principal.LogonType
    $act = $d.Action.Execute + ' ' + $d.Action.Arguments
    if ($act.Length -gt 60) { $act = $act.Substring(0, 60) + '...' }
    '{0,-24} {1,-34} {2}' -f $d.Name, $who, $act
}
''
'共 {0} 个任务；Root={1}；BotUser={2}；CleanupMediaDir={3}' -f $defs.Count, $Root, $BotUser, $CleanupMediaDir

if (-not $Apply) {
    'DRY-RUN：以上是计划，加 -Apply 才注册。'
    exit 0
}

# 交互类任务的 principal 是否可信：没登录过的用户会被任务拒绝运行
$interactive = @($defs | Where-Object { $_.Principal.LogonType -eq 'Interactive' })
if ($interactive.Count -gt 0 -and -not $ForceInteractive) {
    $exists = Get-LocalUser -Name $BotUser -ErrorAction SilentlyContinue
    $profile = Join-Path 'C:\Users' $BotUser
    if (-not $exists -or -not (Test-Path $profile)) {
        Fail ("交互类任务要求 $BotUser 已登录过（当前没有用户配置目录），否则守卫与启动器不会运行") '先按 REBUILD §4 切到专用用户跑一次，再加 -ForceInteractive' 1
    }
}

$failed = @()
foreach ($d in $defs) {
    try {
        Register-ScheduledTask -TaskName $d.Name -Description $d.Desc -Trigger $d.Triggers `
            -Action $d.Action -Principal $d.Principal -Settings $d.Settings -Force | Out-Null
        'OK   ' + $d.Name
    } catch {
        $failed += ($d.Name + ': ' + $_.Exception.Message)
    }
}

if ($failed.Count -gt 0) {
    Fail ('注册失败: ' + ($failed -join '; ')) '检查是否有同名任务被策略锁定，或用管理员重跑' 1
}

'已注册 {0} 个任务。跑 scripts\doctor.ps1 复核 8/8 与 principal。' -f $defs.Count
exit 0
