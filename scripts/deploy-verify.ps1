# 部署自证 —— 装完之后用它证明"真的装好了"，而不是"我觉得装好了"。
#
# 为什么需要它：
#   `deploy-state.ps1` 记的是"哪些步骤跑过了"，但跑过 != 有效。
#   前置检查通过、文件部署了、任务注册了，仍然可能 bot 不回话、库写不进去。
#   这个脚本验的是**能不能用**，不是**做没做**。
#
# 两个模式：
#   -Side company   医生 + 群回应 + 任务落库 + 计划任务
#   -Side employee  个人 bot 在线 + 能被 @ + 能读 vault
#
# 输出（-Json）：
#   {ok, side, pass, fail, checks:[{name, state, detail, fix}], next}
#
# 退出码：0 全 PASS / 1 有 FAIL / 2 用法错误
#
# 用法：
#   powershell -File scripts\deploy-verify.ps1 -Side company -Json
#   powershell -File scripts\deploy-verify.ps1 -Side company -ChatId <真实chatId> -Json
#   powershell -File scripts\deploy-verify.ps1 -Side employee -Json
#   powershell -File scripts\deploy-verify.ps1 -Side company -SkipBot   # 没有群时跳过群回应

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
if (-not $Repo) { $Repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path }

$db = Join-Path $Root 'data\anc.db'
$cli = Join-Path $Repo 'src\service\cli.ts'
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
    $doctorScript = Join-Path $Repo 'scripts\doctor.ps1'
    if (Test-Path $doctorScript) {
        try {
            $dOut = & powershell -NoProfile -ExecutionPolicy Bypass -File $doctorScript -Root $Root -Json 2>&1 | Out-String
            $d = $dOut | ConvertFrom-Json
            if ($d.ok) {
                Add-Check 'doctor' 'PASS' ("FAIL=0 WARN=" + $d.warns + "（" + @($d.checks).Count + " 项）") ''
            } else {
                $bad = @($d.checks | Where-Object { $_.state -eq 'FAIL' } | ForEach-Object { $_.check })
                Add-Check 'doctor' 'FAIL' ("FAIL=" + $d.fails + "：" + ($bad -join ', ')) ("逐项跑 scripts\doctor.ps1 -Root $Root 看 detail 和 fix")
            }
        } catch {
            Add-Check 'doctor' 'FAIL' ('doctor 跑不起来: ' + $_.Exception.Message.Substring(0, [Math]::Min(80, $_.Exception.Message.Length))) '确认 scripts\doctor.ps1 存在且 PowerShell 5.1 可用'
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
                    $probe = Invoke-RestMethod -Uri 'http://127.0.0.1:17999/emit' -Method POST -Body (@{ chatId = $targetChat; user = 'deploy-verify'; content = '自证测试：请回一个「在」' } | ConvertTo-Json) -ContentType 'application/json' -TimeoutSec 10
                    $emitOk = $true
                    $emitDetail = 'len=' + $probe.len
                } catch {
                    $emitDetail = $_.Exception.Message
                }

                if (-not $emitOk) {
                    # 2026-11-05（VERIFY §62）：409 不是故障，是「还没有实例引用」。
                    # preload.cjs 的 /emit 会检查 global.__ancLastClient（一个活的 WecomAiBotClient 实例），
                    # 它只在 bot 收到过真实群消息之后才有值。所以 409 的含义是「先让群里 @ 一次」。
                    # 早先这里一律判 FAIL，导致干净的机器上 deploy-verify 永远 ok=false。
                    if ($emitDetail -match '409') {
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

    # ④ 计划任务：9 个都在且 Ready/Running
    $tasks = @(Get-ScheduledTask -TaskName 'anc-*' -ErrorAction SilentlyContinue)
    $states = $tasks | Group-Object State
    $badTasks = @($tasks | Where-Object { $_.State -notin @('Ready', 'Running') })
    if ($tasks.Count -eq 0) {
        Add-Check 'tasks' 'FAIL' '一个 anc-* 计划任务都没有' '跑部署的 tasks 阶段（REBUILD §3 / AGENT-DEPLOY 对应小节）'
    } elseif ($badTasks.Count -gt 0) {
        Add-Check 'tasks' 'FAIL' ($badTasks.Count.ToString() + ' 个任务不在 Ready/Running：' + (($badTasks | ForEach-Object { $_.TaskName + '=' + $_.State }) -join ', ')) 'Start-ScheduledTask 或删了重建'
    } else {
        Add-Check 'tasks' 'PASS' ($tasks.Count.ToString() + ' 个任务全部 Ready/Running') ''
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
                Add-Check 'bot-reply' 'SKIP' 'test-emit 关闭（默认）' ('要验：建 ' + $flag + ' 然后重启 WorkBuddy')
            } else {
                try {
                    Invoke-RestMethod -Uri 'http://127.0.0.1:17999/emit' -Method POST -Body (@{ chatId = $targetChat; user = 'deploy-verify'; content = '自证测试：请回一个「在」' } | ConvertTo-Json) -ContentType 'application/json' -TimeoutSec 10 | Out-Null
                    Add-Check 'bot-reply' 'PASS' '注入成功（回复要看群里）' ''
                } catch {
                    Add-Check 'bot-reply' 'FAIL' '注入失败' '重启 WorkBuddy 后等 8–30 秒再试'
                }
            }
        }
    }

    # ③ 能读 vault：从 groups.json 拿一个共享路径，读里面的一个文件
    $groupsPath = Join-Path $Root 'render\groups.json'
    if (Test-Path $groupsPath) {
        try {
            $g = Get-Content $groupsPath -Encoding UTF8 -Raw | ConvertFrom-Json
            $vaultShared = ''
            $companyMd = Join-Path $Root 'org\company.md'
            if (Test-Path $companyMd) {
                $m = Select-String -Path $companyMd -Pattern '^vault_shared:\s*(.+)$' -Encoding UTF8
                if ($m) { $vaultShared = $m.Matches[0].Groups[1].Value.Trim() }
            }
            if (-not $vaultShared) {
                Add-Check 'vault-read' 'FAIL' 'org/company.md 里没有 vault_shared' '填上公司共享区路径'
            } elseif (-not (Test-Path $vaultShared)) {
                # 网络路径在未映射时 Test-Path 可能失败，这是常见的"看着装了其实读不到"
                Add-Check 'vault-read' 'FAIL' ("读不到 " + $vaultShared) '检查网络共享是否可访问（net use / 凭据）；共享区是只读挂载'
            } else {
                # 只认业务资料：company/ 或 collab/ 下的 .md。
                # 早先版本用 -Recurse -File 抓任意文件，结果根目录的 .gitignore 也被当成「能读共享区」——
                # 读到 .git 内部文件不算数。见 VERIFY §55.6。
                $bizFile = $null
                $bizDirUsed = ""
                foreach ($d in @('company', 'collab')) {
                    $dir = Join-Path $vaultShared $d
                    if (-not (Test-Path $dir)) { continue }
                    $f = Get-ChildItem $dir -Recurse -File -Filter '*.md' -ErrorAction SilentlyContinue | Select-Object -First 1
                    if ($f) { $bizFile = $f; $bizDirUsed = $d; break }
                }

                if ($bizFile) {
                    try {
                        $null = Get-Content $bizFile.FullName -TotalCount 1 -ErrorAction Stop
                        Add-Check 'vault-read' 'PASS' ('读到 ' + $bizDirUsed + '/' + $bizFile.Name) ''
                    } catch {
                        Add-Check 'vault-read' 'FAIL' ('业务文件在但读不了: ' + $bizDirUsed + '/' + $bizFile.Name) '权限问题：共享区要可读'
                    }
                } else {
                    # 没有业务 .md：区分「整个共享区空」和「有东西但没有业务资料」
                    # 后者是真缺口 —— 说明能读目录却读不到该读的东西
                    $otherFile = Get-ChildItem $vaultShared -Recurse -File -ErrorAction SilentlyContinue |
                                 Where-Object { $_.FullName -notmatch '\\\.git\\' -and $_.FullName -notmatch '\\_originals\\' } |
                                 Select-Object -First 1
                    if ($otherFile) {
                        Add-Check 'vault-read' 'FAIL' '共享区能读，但 company/ 和 collab/ 下没有 .md' '确认 vault_shared 指的是共享区根（不是某一层子目录）；或先入库一份资料'
                    } else {
                        Add-Check 'vault-read' 'SKIP' '共享区是空的（还没入库任何资料）' '这不算错；入库一份资料后再跑'
                    }
                }
            }
        } catch {
            Add-Check 'vault-read' 'FAIL' 'groups.json 解析失败' '重跑 render deploy'
        }
    } else {
        Add-Check 'vault-read' 'FAIL' "没有 $groupsPath" '用 AGENT-DEPLOY-EMPLOYEE §5.5 从公司侧同步 render\groups.json 和 org\company.md —— deploy.ps1 只放渲染器源码，不生成这两个文件'
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
