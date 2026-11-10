# 注册/修复 13 个计划任务（OPS.md「计划任务」表的可执行版本）
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
    # 2026-11-05 改（VERIFY §76）：默认值从 anc-bot 改成 Administrator。
    # 原因是 D25 已经改成「直接用管理员账号部署，不建专用用户」，但这个默认值没跟上 ——
    # 照旧默认值跑会直接报「交互类任务要求 anc-bot 已登录过」，而 REBUILD §4 又写着不建专用用户。
    # 两条指引互相矛盾，陌生 agent 会在这里卡死。仍可显式传 -BotUser anc-bot 回到旧行为。
    # 2026-11-09 改：默认值从 'Administrator' 改成「当前部署账号」（D25：直接用管理员账号部署，不建专用用户）。
    #   原默认值与 D25 矛盾：在非 Administrator 的机器上照默认值跑会要求该用户已登录过，
    #   而实际交互任务是当前登录用户。显式传 -BotUser 可覆盖。
    [string]$BotUser = $env:USERNAME,
    [string]$Root = '',
    [string]$ServiceAccount = 'LOCAL SERVICE',
    [string]$CleanupMediaDir = '',
    [string]$BackupDestination = 'E:\anc-backup',
    # 仓库路径。anc-devbot 要在这里跑（它要 git 和 light/personas/，不能在 bin/ 里跑）
    [string]$Repo = '',
    [string[]]$Only = @(),
    [switch]$Apply,
    [switch]$ForceInteractive
)

$ErrorActionPreference = 'Stop'
if (-not $Root) { $Root = Join-Path $env:ProgramData 'anc' }
if (-not $CleanupMediaDir) { $CleanupMediaDir = "C:\Users\$BotUser\AppData\Local\Temp\workbuddy-wecom-media" }
$bin = Join-Path $Root 'bin'
# 仓库路径：从脚本位置向上找 .git（脚本已按域分组，不能写死层级）。
if (-not $Repo) {
    $c = $PSScriptRoot
    while ($c -and -not (Test-Path (Join-Path $c '.git'))) {
        $p = Split-Path -Parent $c
        if ($p -eq $c) { break }
        $c = $p
    }
    $Repo = $c
}

function Fail([string]$msg, [string]$fix, [int]$code) {
    Write-Host "ERROR $msg"
    Write-Host "FIX   $fix"
    exit $code
}

if (-not (Test-Path $bin)) { Fail "找不到 $bin" '先跑 scripts\deploy\deploy.ps1 -Apply 部署脚本' 2 }
foreach ($need in 'anc-loop.cmd', 'anc-launch.cmd', 'anc-guard.cmd', 'run-hidden.vbs') {
    if (-not (Test-Path (Join-Path $bin $need))) { Fail "缺少 $bin\$need" '先跑 scripts\deploy\deploy.ps1 -Apply' 2 }
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
    # 7×24 主机：电池供电也要跑、断电也不能停（默认 True，会静默停任务）
    # 参数名是 -AllowStartIfOnBatteries / -DontStopIfGoingOnBatteries（原来写成 -Disallow... / -Stop... 是错的）
    return New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -ExecutionTimeLimit (New-TimeSpan -Minutes ([int]($limit -replace 'PT|M', '')))
}

function New-ServicePrincipal([string]$user, [string]$level = 'Limited') {
    return New-ScheduledTaskPrincipal -UserId $user -LogonType ServiceAccount -RunLevel $level
}
function New-InteractivePrincipal([string]$user) {
    return New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
}

# 任务定义（与 OPS.md 的表一一对应）
# anc-devbot 的参数串。**两个坑叠在一起**：
#  ① 必须先算进变量再传给 -Argument：直接写 -Argument ('-NoProfile ...')
#     括号表达式以 - 开头会被当成参数名，Argument 变空、后面所有参数错位。
#  ② 必须定义在 $defs 之前：@{} 里的表达式在给 $defs 赋值时就求值了，
#     定义在后面拿到的是 $null（报 "Argument is null or empty"）。
$devbotArg = '-NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $Repo 'scripts\devbot\devbot-scheduler.ps1') + '" -Apply -Repo "' + $Repo + '"'

$defs = @(
    @{
        Name = 'anc-service'; Desc = '本地小服务：每分钟一次 tick'
        Triggers = @((New-EveryMinutesTrigger 1), (New-ScheduledTaskTrigger -AtStartup))
        Action = (New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ('/c "' + (Join-Path $bin 'anc-loop.cmd') + '"'))
        Principal = (New-ServicePrincipal $ServiceAccount)
        Settings = (New-Settings 'PT2M')
    },
    @{
        Name = 'anc-executor-wake'; Desc = '主干2 每分钟检查队列，有 queued 才唤醒 WorkBuddy'
        Triggers = @((New-EveryMinutesTrigger 1))
        Action = (New-PsAction 'wake-if-queued.ps1')
        Principal = (New-ServicePrincipal $ServiceAccount)
        Settings = (New-Settings 'PT1M')
    },
    @{
        Name = 'anc-executor-new-host'; Desc = '主干2 03:00 自动创建新 host 对话；失败由 host-tick 兜底'
        Triggers = @((New-ScheduledTaskTrigger -Daily -At '03:00'))
        Action = (New-PsAction 'new-host.ps1')
        Principal = (New-ServicePrincipal $ServiceAccount)
        Settings = (New-Settings 'PT5M')
    },
    @{
        Name = 'anc-executor-host-tick'; Desc = '主干2 03:00 host 自动兜底：无新对话时只标 deferred'
        Triggers = @((New-ScheduledTaskTrigger -Daily -At '03:00'))
        Action = (New-PsAction 'host-tick.ps1')
        Principal = (New-ServicePrincipal $ServiceAccount)
        Settings = (New-Settings 'PT5M')
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
        Name = 'anc-http'; Desc = '本地 HTTP 面：只监听 127.0.0.1，供 watchdog 与后台任务用'
        Triggers = @((New-ScheduledTaskTrigger -AtStartup), (New-EveryMinutesTrigger 1))
        Action = (New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ('/c "' + (Join-Path $bin 'anc-http.cmd') + '"'))
        Principal = (New-ServicePrincipal $ServiceAccount)
        Settings = (New-Settings 'PT0M')
    },
    @{
        Name = 'anc-update-watch'; Desc = '每天 09:00 查厂商更新接口，有新版本发运维群'
        Triggers = @((New-ScheduledTaskTrigger -Daily -At '09:00'))
        Action = (New-PsAction 'check-workbuddy-update.ps1')
        Principal = (New-ServicePrincipal $ServiceAccount)
        Settings = (New-Settings 'PT5M')
    },
    @{
        # devbot 自动启动：工作日 22:00~06:00 每 30 分钟查一次「全员下班」，满足条件就跑一条 open issue。
        #
        # **动作指向仓库里的脚本，不是 bin/ 里的**：devbot-scheduler 要 git 和 light/personas/，
        #   部署到 bin/ 之后两级上溯会落到 %ProgramData%\anc，那里没有仓库。
        #
        # **principal 必须是 $BotUser（交互），不能是 SYSTEM**。2026-11-05 实测 SYSTEM 下两个硬伤：
        #   ① devbot.ps1 的 $LivePersona = %USERPROFILE%\WorkBuddy\Claw\CODEBUDDY.md，
        #      SYSTEM 的 %USERPROFILE% 是 C:\Windows\system32\config\systemprofile —— 那里没有 WorkBuddy，
        #      切 persona 会写到不存在的位置（或写到错的用户下）
        #   ② git 直接拒绝：fatal: detected dubious ownership（仓库属于 Administrator，当前是 SYSTEM）
        # 这和 anc-workbuddy-launch / anc-patch-guard 用同一个 principal —— 因为 devbot 要动的是
        # 同一个用户的 WorkBuddy persona。
        Name = 'anc-devbot'; Desc = 'devbot 自动启动：工作日 22:00~06:00 每 30 分钟查「全员下班」'
        Triggers = @((New-EveryMinutesTrigger 30 '22:00'))
        Action = (New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $devbotArg)
        Principal = (New-InteractivePrincipal $BotUser)
        Settings = (New-Settings 'PT30M')
    }
)


# 只注册指定的任务（R1 之前用 -Only anc-http 之类，避免动到交互类任务的 principal）
if ($Only.Count -gt 0) {
    $defs = @($defs | Where-Object { $Only -contains $_.Name })
    if ($defs.Count -eq 0) { Fail ('没有匹配的任务: ' + ($Only -join ',')) '用 -Only 指定 OPS 表里的任务名' 2 }
}

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
            -Action $d.Action -Principal $d.Principal -Settings $d.Settings -Force -ErrorAction Stop | Out-Null
        'OK   ' + $d.Name
    } catch {
        $failed += ($d.Name + ': ' + $_.Exception.Message)
    }
}

if ($failed.Count -gt 0) {
    Fail ('注册失败: ' + ($failed -join '; ')) '检查是否有同名任务被策略锁定，或用管理员重跑' 1
}

'已注册 {0} 个任务。跑 scripts\doctor\doctor.ps1 复核 {0} 项与 principal。' -f $defs.Count
exit 0
