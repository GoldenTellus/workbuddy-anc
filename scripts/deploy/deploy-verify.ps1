# 部署自证 —— 装完之后用它证明"真的装好了"，而不是"我觉得装好了"。
#
# 为什么需要它：
#   `deploy-state.ps1` 记的是"哪些步骤跑过了"，但跑过 != 有效。
#   前置检查通过、文件部署了、任务注册了，仍然可能 bot 不回话、库写不进去。
#   这个脚本验的是**能不能用**，不是**做没做**。
#
# 两个模式：
#   -Side company   医生 + 群回应 + 任务落库 + 计划任务
#   -Side employee  个人 bot 在线 + 能被 @ + 本地 persona（不读公司库）
#
# 输出（-Json）：
#   {ok, side, pass, fail, checks:[{name, state, detail, fix}], next}
#
# 退出码：0 全 PASS / 1 有 FAIL / 2 用法错误
#
# 用法：
#   powershell -File scripts\deploy\deploy-verify.ps1 -Side company -Json
#   powershell -File scripts\deploy\deploy-verify.ps1 -Side company -ChatId <真实chatId> -Json
#   powershell -File scripts\deploy\deploy-verify.ps1 -Side employee -Json
#   powershell -File scripts\deploy\deploy-verify.ps1 -Side company -SkipBot   # 没有群时跳过群回应

param(
    [ValidateSet('company', 'employee')]
    [string]$Side = 'company',

    [string]$Root = '',
    [string]$Repo = '',

    # 往哪个群注入测试消息（company 侧）。不传就用库里第一个 chat_bindings
    [string]$ChatId = '',

    # 跳过「群回应」那项：装的时候可能还没有群/机器人
    [switch]$SkipBot,

    # 不清理测试数据（排查时想留着看）
    [switch]$KeepData,

    [switch]$Json
)

$ErrorActionPreference = 'Stop'

if (-not $Root) {
    $Root = if ($Side -eq 'company') { Join-Path $env:ProgramData 'anc' } else { Join-Path $env:LOCALAPPDATA 'anc' }
}
# 2026-11-05 改（VERIFY §76）：原来直接取 $PSScriptRoot\..，但那在**部署目录**里是错的。
# 仓库布局：  <repo>\scripts\deploy\deploy-verify.ps1 + <repo>\scripts\doctor\doctor.ps1 + <repo>\src\service\cli.ts
# 部署布局：  <Root>\bin\deploy-verify.ps1    + <Root>\bin\doctor.ps1    + <Root>\service\cli.ts
# 两者目录名不同，所以必须探测，不能猜。找不到就明确报错，别让它带着错的 $Repo 跑出一堆假 FAIL。
if (-not $Repo) {
    # $PSScriptRoot 的上一级在两种布局里都是「根」：
    #   仓库: <repo>\scripts\deploy\..\..  = <repo>
    #   部署: <Root>\bin\..              = <Root>（就是 %ProgramData%\anc）
    # 但根下面的子目录名不同（scripts vs bin、src\service vs service），所以要逐个试。
    $root3 = (Resolve-Path (Join-Path $PSScriptRoot '..\..') -ErrorAction SilentlyContinue).Path
    $root2 = (Resolve-Path (Join-Path $PSScriptRoot '..') -ErrorAction SilentlyContinue).Path
    foreach ($c in @($root3, $root2, $PSScriptRoot)) {
        if (-not $c) { continue }
        $cliProbe = if (Test-Path (Join-Path $c 'src\service\cli.ts')) { Join-Path $c 'src\service\cli.ts' } else { Join-Path $c 'service\cli.ts' }
        $docProbe = if (Test-Path (Join-Path $c 'scripts\doctor\doctor.ps1')) { Join-Path $c 'scripts\doctor\doctor.ps1' } else { Join-Path $c 'bin\doctor.ps1' }
        if ((Test-Path $cliProbe) -and (Test-Path $docProbe)) { $Repo = $c; break }
    }
    if (-not $Repo) {
        Write-Host 'ERROR 猜不出仓库/部署根 —— 请显式传 -Repo'
        Write-Host 'FIX   仓库里跑：-Repo <repo>；部署目录里跑：-Repo %ProgramData%\\anc'
        exit 2
    }
}

$db = Join-Path $Root 'data\anc.db'
# 两种布局：仓库里是 src\service\cli.ts，部署目录里是 service\cli.ts（VERIFY §76）
$cli = if (Test-Path (Join-Path $Repo 'src\service\cli.ts')) { Join-Path $Repo 'src\service\cli.ts' } else { Join-Path $Repo 'service\cli.ts' }
if (-not (Test-Path $cli)) { Write-Host ('ERROR 找不到 cli.ts：' + $cli); exit 2 }
$results = @()

function Add-Check([string]$name, [string]$state, [string]$detail, [string]$fix) {
    $script:results += [pscustomobject]@{ name = $name; state = $state; detail = $detail; fix = $fix }
}

function Get-CliJson([string[]]$cliArgs) {
    try {
        $out = & node --no-warnings $cli --db $db --json @cliArgs 2>&1 | Out-String
        return ($out | ConvertFrom-Json)
    } catch { return $null }
}

# ── 1. 库在不在（后面所有检查的前提）────────────────────────
if (-not (Test-Path $db)) {
    Add-Check 'database' 'FAIL' "没有库: $db" ('库由 `cli.ts --db $db` 顺带创建（openDb 在检查命令组之前）；deploy.ps1 只放源码不建库。跑任意一条：node --no-warnings ' + (Join-Path $Root 'service\cli.ts') + ' --db "' + $db + '"')
    # 库都没有，后面查不了，直接输出
    $fail = @($results | Where-Object { $_.state -eq 'FAIL' }).Count
    $out0 = [pscustomobject]@{
        ok     = $false
        side   = $Side
        pass   = 0
        fail   = $fail
        checks = $results
        next   = '库不存在，先把部署跑完再做自证。'
    }
    if ($Json) { $out0 | ConvertTo-Json -Depth 5 } else {
        Write-Host ("=== deploy-verify ({0}) ===" -f $Side)
        foreach ($c in $results) { Write-Host ("  {0,-14} {1}  {2}" -f $c.name, $c.state, $c.detail) }
        Write-Host ''
        Write-Host ("NEXT  {0}" -f $out0.next)
    }
    exit 1
}
Add-Check 'database' 'PASS' "库存在: $db" ''

# ── 公司侧 ──────────────────────────────────────────────────
if ($Side -eq 'company') {

    # ① doctor：整体健康
    # 两种布局：仓库里是 <repo>\scripts\doctor\doctor.ps1，部署目录里是 <Root>\bin\doctor.ps1（VERIFY §76）
$doctorScript = if (Test-Path (Join-Path $Repo 'scripts\doctor\doctor.ps1')) { Join-Path $Repo 'scripts\doctor\doctor.ps1' } else { Join-Path $Repo 'bin\doctor.ps1' }
if (-not (Test-Path $doctorScript)) { Write-Host ('ERROR 找不到 doctor.ps1：' + $doctorScript); exit 2 }
    if (Test-Path $doctorScript) {
        try {
            $docArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $doctorScript, '-Root', $Root, '-Json')
            # 2026-11-09 修（GAP-068）：不传 -Repo 时 doctor 的 secrets-in-git 只能 WARN，
            # 导致 deploy-verify 里的 WARN 数比直接跑 doctor 多 1，看起来像不一致。
            if (Test-Path (Join-Path $Repo '.git')) { $docArgs += @('-Repo', $Repo) }
            $dOut = & powershell @docArgs 2>&1 | Out-String
            $d = $dOut | ConvertFrom-Json
            if ($d.ok) {
                Add-Check 'doctor' 'PASS' ("FAIL=0 WARN=" + $d.warns + "（" + @($d.checks).Count + " 项）") ''
            } else {
                $bad = @($d.checks | Where-Object { $_.state -eq 'FAIL' } | ForEach-Object { $_.check })
                Add-Check 'doctor' 'FAIL' ("FAIL=" + $d.fails + "：" + ($bad -join ', ')) ("逐项跑 scripts\doctor\doctor.ps1 -Root $Root 看 detail 和 fix")
            }
        } catch {
            Add-Check 'doctor' 'FAIL' ('doctor 跑不起来: ' + $_.Exception.Message.Substring(0, [Math]::Min(80, $_.Exception.Message.Length))) '确认 scripts\doctor\doctor.ps1 存在且 PowerShell 5.1 可用'
        }
    } else {
        Add-Check 'doctor' 'FAIL' "找不到 $doctorScript" '确认仓库完整（git clone 没漏子目录）'
    }

    # ② 任务落库：写一条再删掉，证明库能写
    #    这是最直接的"服务真的能干活"证据——比看进程在不在靠谱
    $probeChat = 'deploy-verify-probe'
    $probeUser = 'deploy-verify-probe-user'
    $probeTitle = 'deploy-verify ' + (Get-Date -Format 'HHmmss')
    $before = Get-CliJson @('task', 'list', '--chat-id', $probeChat)
    $beforeCount = if ($before -and $before.tasks) { @($before.tasks).Count } else { 0 }
    $added = Get-CliJson @('task', 'add', '--chat-id', $probeChat, '--title', $probeTitle, '--requester-userid', $probeUser, '--due-local', ((Get-Date).AddHours(1).ToString('yyyy-MM-dd HH:mm')))
    if ($added -and $added.ok -and $added.task) {
        $after = Get-CliJson @('task', 'list', '--chat-id', $probeChat)
        $afterCount = if ($after -and $after.tasks) { @($after.tasks).Count } else { 0 }
        if ($afterCount -eq $beforeCount + 1) {
            Add-Check 'task-write' 'PASS' ('task #' + $added.task.id + ' 写进去了，查得回来') ''
        } else {
            Add-Check 'task-write' 'FAIL' ("写成功但查不回来（" + $beforeCount + " → " + $afterCount + "）") '库可能被锁或 WAL 没落盘；看 anc-loop.log'
        }
    } else {
        Add-Check 'task-write' 'FAIL' 'task add 失败' '跑 node src\service\cli.ts --db <库> task add ... 看原始报错'
    }
    # 清理（除非 -KeepData）
    if (-not $KeepData) {
        try {
            $clean = @"
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(String.raw``$db``);
db.prepare("DELETE FROM reminders WHERE task_id IN (SELECT id FROM tasks WHERE chat_id=?)").run('$probeChat');
db.prepare("DELETE FROM task_events WHERE task_id IN (SELECT id FROM tasks WHERE chat_id=?)").run('$probeChat');
db.prepare('DELETE FROM tasks WHERE chat_id=?').run('$probeChat');
"@
            $tmp = Join-Path $env:TEMP ('anc-verify-clean-' + [guid]::NewGuid().ToString('N') + '.cjs')
            [IO.File]::WriteAllText($tmp, $clean, (New-Object Text.UTF8Encoding($false)))
            & node --no-warnings $tmp 2>&1 | Out-Null
            Remove-Item $tmp -Force -ErrorAction SilentlyContinue
        } catch { }
    }

    # ③ 群回应：注入一条消息，看 bot 是否回话
    #    这是唯一能证明"persona + 补丁 + 企微链路都对"的方式
    if ($SkipBot) {
        Add-Check 'bot-reply' 'SKIP' '按 -SkipBot 跳过' ''
    } else {
        $targetChat = $ChatId
        if (-not $targetChat) {
            # 从 chat_bindings 拿第一个
            try {
                $b = Get-CliJson @('bind', 'list')
                if ($b -and $b.bindings) {
                    $first = @($b.bindings) | Select-Object -First 1
                    if ($first) { $targetChat = $first.chat_id }
                }
            } catch { }
        }
        if (-not $targetChat) {
            Add-Check 'bot-reply' 'SKIP' '没有已绑定的群，也没有传 -ChatId' '装完群之后用 -ChatId <真实chatId> 重跑这一项'
        } else {
            # 判据分两层，这是这套脚本最值得说的一处设计：
            #
            #   第一层「注入成功」= 17999 在 listen 且 POST 返回 ok:true。
            #   这证明链路是通的：消息能进 WorkBuddy。这一层能立刻判，不依赖模型。
            #
            #   第二层「等到回复」= patch-out.log 里出现新的 chat= 行。
            #   这依赖模型行为，而 VERIFY §40 实测过：并发 6 条时最后一条等了 8 分钟。
            #   所以超时不能判 FAIL——「回复慢」和「坏了」是两件不同的事。
            #
            #   早先版本把超时判 FAIL、超时 90 秒，在真机上误报了。
            #   改成：注入成功就 PASS（detail 里写清「回复未在窗口内确认」），
            #   只有注入本身失败才 FAIL，只有端口没监听才 SKIP。

            # 先探端口：flag 文件存在只表示「下次启动会开」，不代表现在开着
            # （OPS.md 记过这个语义；§41 也踩过）
            $listening = [bool](Get-NetTCPConnection -LocalPort 17999 -State Listen -ErrorAction SilentlyContinue)
            $flag = Join-Path $Root 'data\test-emit.flag'

            if (-not $listening) {
                if (-not (Test-Path $flag)) {
                    Add-Check 'bot-reply' 'SKIP' 'test-emit 关闭（默认状态），17999 没监听' ('要验群回应：建 ' + $flag + '（内容随意），重启 WorkBuddy（flag 是启动时读一次），等 8–30 秒再重跑')
                } else {
                    Add-Check 'bot-reply' 'SKIP' ('flag 在，但 17999 没监听——说明当前进程是建 flag 之前启动的') '重启 WorkBuddy 让它生效，再重跑本脚本'
                }
            } else {
                $emitOk = $false
                $emitDetail = ''
                try {
                    # 2026-11-06 修（VERIFY §25 / §85.2）：PS 5.1 的 Invoke-RestMethod 传字符串
                    # body 时可能按 GBK 编码，中文到 bot 已成乱码。显式给 UTF-8 字节才稳。
                    $emitJson = @{ chatId = $targetChat; user = 'deploy-verify'; content = '自证测试：请回一个「在」' } | ConvertTo-Json
                    $emitParams = @{
                        Uri = 'http://127.0.0.1:17999/emit'; Method = 'POST'
                        Body = [Text.Encoding]::UTF8.GetBytes($emitJson)
                        ContentType = 'application/json; charset=utf-8'; TimeoutSec = 10
                    }
                    # /emit 启用 emit-token.txt 时必须带 X-Anc-Token，否则自证会拿到 401
                    $emitTokFile = Join-Path $Root 'data\emit-token.txt'
                    if (Test-Path $emitTokFile) {
                        $emitParams['Headers'] = @{ 'X-Anc-Token' = (Get-Content $emitTokFile -Raw -Encoding UTF8).Trim() }
                    }
                    $probe = Invoke-RestMethod @emitParams
                    $emitOk = $true
                    $emitDetail = 'len=' + $probe.len
                } catch {
                    $emitDetail = $_.Exception.Message
                    # 2026-11-05 加（VERIFY §80）：17999 在听但没人处理时（flag 删了、进程没重启）
                    # POST 会挂到超时。超时不是"注入失败"，是"端口通但没有 handler"，判 SKIP 更准。
                }

                if (-not $emitOk) {
                    # 2026-11-05（VERIFY §62）：409 不是故障，是「还没有实例引用」。
                    # preload.cjs 的 /emit 会检查 global.__ancLastClient（一个活的 WecomAiBotClient 实例），
                    # 它只在 bot 收到过真实群消息之后才有值。所以 409 的含义是「先让群里 @ 一次」。
                    # 早先这里一律判 FAIL，导致干净的机器上 deploy-verify 永远 ok=false。
                    if ($emitDetail -match 'timed out|操作已超时|超时|Timeout') {
                        Add-Check 'bot-reply' 'SKIP' '17999 在监听但 POST 超时（端口通、没有 handler）' '典型原因：test-emit.flag 已删但 WorkBuddy 没重启过（flag 是启动时读一次）。重启 WorkBuddy 后 17999 会关闭；要验群回应则重建 flag 再重启'
                    } elseif ($emitDetail -match '409') {
                        Add-Check 'bot-reply' 'SKIP' '还没有实例引用（需先在群里收到一条真实消息）' '这是设计：test-emit 依赖一个活的 WecomAiBotClient 实例。让群里有人 @ 一次 bot，再重跑本脚本'
                    } else {
                        Add-Check 'bot-reply' 'FAIL' ('注入失败: ' + $emitDetail.Substring(0, [Math]::Min(80, $emitDetail.Length))) '17999 在监听但 POST 失败；看 WorkBuddy 的 daemon.log'
                    }
                } else {
                    # 注入成功 = 链路通。再花 60 秒看一眼有没有回复，超时不算失败。
                    $outLog = Join-Path $Root 'data\patch-out.log'
                    $sizeBefore = if (Test-Path $outLog) { (Get-Item $outLog).Length } else { 0 }
                    $deadline = (Get-Date).AddSeconds(60)
                    $found = $false
                    while ((Get-Date) -lt $deadline) {
                        Start-Sleep -Seconds 5
                        if (Test-Path $outLog) {
                            $sizeNow = (Get-Item $outLog).Length
                            if ($sizeNow -gt $sizeBefore) {
                                # 按字节读新增部分（中文 3 字节一字，用字符数切会错位）
                                $bytes2 = [IO.File]::ReadAllBytes($outLog)
                                $newText = [Text.Encoding]::UTF8.GetString($bytes2, $sizeBefore, $sizeNow - $sizeBefore)
                                if ($newText -match 'chat=') { $found = $true; break }
                            }
                        }
                    }
                    if ($found) {
                        Add-Check 'bot-reply' 'PASS' ('注入成功（' + $emitDetail + '），60 秒内看到回复') ''
                    } else {
                        Add-Check 'bot-reply' 'PASS' ('注入成功（' + $emitDetail + '），但 60 秒内没等到回复') '链路是通的；回复慢是模型行为（§40 记过并发时等到 8 分钟）。去群里看有没有回'
                    }
                }
            }
        }
    }

    # ④ 计划任务：13 个都在且 Ready/Running
    #
    # 2026-11-10 修（GAP-081 的教训）：原来只判「拿到的 anc-* 都 Ready/Running」，
    # 一个都没注册时会 FAIL，但**只注册了 3 个也 PASS** —— 当时 doctor 里就那么漏过去的。
    # 现在按 OPS 任务表逐个核对名称；交互类任务（登录用户可见）缺失直接 FAIL，
    # 服务类任务在非提权会话里本来就看不到，这时只 SKIP 不 FAIL。
    $expectedTasks = @(
        'anc-service', 'anc-elevate', 'anc-executor-wake', 'anc-executor-new-host', 'anc-executor-host-tick',
        'anc-backup', 'anc-boot-alert', 'anc-cleanup', 'anc-watchdog',
        'anc-workbuddy-launch', 'anc-patch-guard', 'anc-http', 'anc-update-watch', 'anc-devbot'
    )
    $interactiveTasks = @('anc-workbuddy-launch', 'anc-patch-guard', 'anc-devbot')
    $tasks = @(Get-ScheduledTask -TaskName 'anc-*' -ErrorAction SilentlyContinue)
    $present = @($tasks | ForEach-Object { $_.TaskName })
    $missingAll = @($expectedTasks | Where-Object { $present -notcontains $_ })
    $missingCritical = @($missingAll | Where-Object { $interactiveTasks -contains $_ })
    $badTasks = @($tasks | Where-Object { $_.State -notin @('Ready', 'Running') })
    $isElevated = $false
    try {
        $isElevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
            [Security.Principal.WindowsBuiltInRole]::Administrator)
    } catch { }

    if ($tasks.Count -eq 0) {
        Add-Check 'tasks' 'FAIL' '一个 anc-* 计划任务都没有' '跑 scripts\deploy\register-tasks.ps1 -Apply（要管理员会话）'
    } elseif ($missingCritical.Count -gt 0) {
        Add-Check 'tasks' 'FAIL' ('缺交互类任务：' + ($missingCritical -join ', ')) 'register-tasks.ps1 -Apply；这三个决定 WorkBuddy 会不会被拉起、补丁会不会自愈'
    } elseif ($badTasks.Count -gt 0) {
        Add-Check 'tasks' 'FAIL' ($badTasks.Count.ToString() + ' 个任务不在 Ready/Running：' + (($badTasks | ForEach-Object { $_.TaskName + '=' + $_.State }) -join ', ')) 'Start-ScheduledTask；被禁用要查原因，别直接 Enable'
    } elseif ($missingAll.Count -gt 0 -and -not $isElevated) {
        Add-Check 'tasks' 'SKIP' ('非提权会话看不到 ' + $missingAll.Count + ' 个服务任务（' + ($missingAll -join ', ') + '），其余 ' + $present.Count + ' 个 Ready/Running') '用管理员会话重跑本项才能核对全量'
    } elseif ($missingAll.Count -gt 0) {
        Add-Check 'tasks' 'FAIL' ('缺 ' + $missingAll.Count + ' 个任务：' + ($missingAll -join ', ')) 'register-tasks.ps1 -Apply 重新注册；核对 OPS.md 任务表'
    } else {
        Add-Check 'tasks' 'PASS' ($tasks.Count.ToString() + ' 个任务齐全且全部 Ready/Running') ''
    }

    # 主干2：部署后自动 host 的证据（工作区 + TEST + 当天 host）
    $wakeFlag = Join-Path $Root 'data\wb-wake.flag'
    $execState = Join-Path $Root 'data\executor-deploy.json'
    $execFailed = Join-Path $Root 'data\deploy-executor-failed.json'
    if (Test-Path $execState) {
        try {
            $es = [IO.File]::ReadAllText($execState, [Text.Encoding]::UTF8).TrimStart([char]0xFEFF) | ConvertFrom-Json
            if ($es.ok) {
                Add-Check 'executor' 'PASS' ('ok：workspace=' + $es.workspace + ' conv=' + $es.conversation_id + ' host=' + $es.host_action + '/' + $es.host_id) ''
            } else {
                Add-Check 'executor' 'FAIL' ('executor-deploy.json ok=false：' + $es.error) '看 data\executor-deploy.log；修好后跑 tools\setup-executor.ps1 -Apply 重试'
            }
        } catch {
            Add-Check 'executor' 'FAIL' ('executor-deploy.json 解析失败: ' + $_.Exception.Message) '删掉重跑 tools\setup-executor.ps1 -Apply'
        }
    } elseif (Test-Path $execFailed) {
        Add-Check 'executor' 'FAIL' '部署后自动步骤重试超限（deploy-executor-failed.json）' '看 executor-deploy.log；修好后跑 tools\setup-executor.ps1 -Apply'
    } elseif (Test-Path $wakeFlag) {
        Add-Check 'executor' 'WARN' '已启用 wake bridge，但还没有 executor-deploy.json（部署后自动步骤可能未完成）' '等 patch-guard 一分钟；或跑 tools\setup-executor.ps1 -Apply'
    } else {
        Add-Check 'executor' 'SKIP' '未启用主干2 host（没有 wb-wake.flag）' '要启用：tools\setup-executor.ps1 -Apply'
    }
}

# ── 员工侧 ──────────────────────────────────────────────────
if ($Side -eq 'employee') {

    # ① 个人 bot 在线：WorkBuddy 进程在跑
    $wb = @(Get-Process -Name 'WorkBuddy' -ErrorAction SilentlyContinue)
    if ($wb.Count -gt 0) {
        Add-Check 'bot-online' 'PASS' ($wb.Count.ToString() + ' 个 WorkBuddy 进程') ''
    } else {
        Add-Check 'bot-online' 'FAIL' 'WorkBuddy 没在跑' '启动 WorkBuddy 并登录；装完没重启的话 persona 还没生效'
    }

    # ② 能被 @ 回应
    if ($SkipBot) {
        Add-Check 'bot-reply' 'SKIP' '按 -SkipBot 跳过' ''
    } else {
        $targetChat = $ChatId
        if (-not $targetChat) {
            try {
                $b = Get-CliJson @('bind', 'list')
                if ($b -and $b.bindings) {
                    $first = @($b.bindings) | Select-Object -First 1
                    if ($first) { $targetChat = $first.chat_id }
                }
            } catch { }
        }
        if (-not $targetChat) {
            Add-Check 'bot-reply' 'SKIP' '没有绑定群' '先 cli bind set --chat-id <你的群> --employee <你的 id> --userid <你的 userid>（注意 set 子命令不能省）'
        } else {
            $flag = Join-Path $Root 'data\test-emit.flag'
            if (-not (Test-Path $flag)) {
                # 员工侧默认**不装补丁**（DEPLOY-EMPLOYEE §3 不装补丁；§8 专门解释过这一项验不了）：
                # 没有 preload 就没有 17999，也就没有 test-emit。建 flag 只会白折腾 ——
                # 早先这里的 fix 是从公司侧抄来的「建 flag 再重启」，在员工机上照着做必然无效。
                Add-Check 'bot-reply' 'SKIP' '员工侧不装补丁，没有 test-emit（17999 不会监听）' '让本人在群里 @ 一次个人 bot、看有没有回复，把结果写进汇报；SKIP 不是通过'
            } else {
                try {
                    $emitJson = @{ chatId = $targetChat; user = 'deploy-verify'; content = '自证测试：请回一个「在」' } | ConvertTo-Json
                    $emitParams = @{
                        Uri = 'http://127.0.0.1:17999/emit'; Method = 'POST'
                        Body = [Text.Encoding]::UTF8.GetBytes($emitJson)
                        ContentType = 'application/json; charset=utf-8'; TimeoutSec = 10
                    }
                    # /emit 启用 emit-token.txt 时必须带 X-Anc-Token，否则自证会拿到 401
                    $emitTokFile = Join-Path $Root 'data\emit-token.txt'
                    if (Test-Path $emitTokFile) {
                        $emitParams['Headers'] = @{ 'X-Anc-Token' = (Get-Content $emitTokFile -Raw -Encoding UTF8).Trim() }
                    }
                    Invoke-RestMethod @emitParams | Out-Null
                    Add-Check 'bot-reply' 'PASS' '注入成功（回复要看群里）' ''
                } catch {
                    Add-Check 'bot-reply' 'FAIL' '注入失败' '重启 WorkBuddy 后等 8–30 秒再试'
                }
            }
        }
    }

    # ③ 本地 persona：员工侧不读公司库，不再检查 vault-read
    $livePersona = Join-Path $env:USERPROFILE 'WorkBuddy\Claw\CODEBUDDY.md'
    if (-not (Test-Path $livePersona)) {
        Add-Check 'persona' 'FAIL' '没有本地 persona' '运行 scripts\deploy\employee-bootstrap.ps1 -Repo <仓库> -Apply，然后重启 WorkBuddy'
    } else {
        $personaText = Get-Content $livePersona -Raw -Encoding UTF8
        if ($personaText -match 'vault_shared|anc-vault-read') {
            Add-Check 'persona' 'FAIL' 'persona 仍含公司库/旧技能依赖' '重新运行 employee-bootstrap.ps1 -Apply；员工侧不应出现 vault 路径或 anc-vault-read'
        } elseif ($personaText -notmatch '公司 bot|公司bot') {
            Add-Check 'persona' 'FAIL' 'persona 没有公司 bot 引导' '模板/生成结果异常；重跑 employee-bootstrap.ps1'
        } else {
            Add-Check 'persona' 'PASS' '本地 persona 已生成，公司知识引导到公司 bot' ''
        }
    }
}

# ── 输出 ────────────────────────────────────────────────────
$pass = @($results | Where-Object { $_.state -eq 'PASS' }).Count
$fail = @($results | Where-Object { $_.state -eq 'FAIL' }).Count
$skip = @($results | Where-Object { $_.state -eq 'SKIP' }).Count
$ok = ($fail -eq 0)

$next = if ($ok -and $skip -eq 0) {
    '全部通过。'
} elseif ($ok) {
    '没有 FAIL，但有 ' + $skip + ' 项 SKIP——那不是通过，是没验。列在下面了。'
} else {
    '有 ' + $fail + ' 项 FAIL。逐项按 fix 处理，改完重跑本脚本（只重跑这一项也行）。'
}

$out = [pscustomobject]@{
    ok     = $ok
    side   = $Side
    pass   = $pass
    fail   = $fail
    skip   = $skip
    checks = $results
    next   = $next
}

if ($Json) {
    $out | ConvertTo-Json -Depth 5
} else {
    Write-Host ("=== deploy-verify ({0}) ===" -f $Side)
    Write-Host ("根: {0}" -f $Root)
    Write-Host ''
    foreach ($c in $results) {
        Write-Host ("  {0,-14} {1,-5} {2}" -f $c.name, $c.state, $c.detail)
        if ($c.fix) { Write-Host ("  {0,-14} {1,-5} FIX  {2}" -f '', '', $c.fix) }
    }
    Write-Host ''
    Write-Host ("结果  PASS={0}  FAIL={1}  SKIP={2}" -f $pass, $fail, $skip)
    Write-Host ("NEXT  {0}" -f $next)
}

exit $(if ($ok) { 0 } else { 1 })
