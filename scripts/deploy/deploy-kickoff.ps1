# 部署入口：先访谈，再执行。
#
# 为什么要有这个脚本：
#   原来的部署是「agent 读 1200 行手册、边读边做、缺什么回头问」。结果打断是分散的：
#   做到 §5.5 才发现要拷 render\members、做到 §6 才发现没问「哪个成员 id 是你」、
#   做到 §10.5 才发现 webhook 文件名要和 member 对上。装的人被反复拉回来回答零散问题。
#
#   这个脚本把「问什么」和「装什么」分开：
#     -Phase identity  第一问：你是谁、装哪一侧。side 由身份推出，不让安装人自己判断。
#     -Phase prepare   给人看的准备清单（建群、拿 chatId、拿 webhook、装空 WorkBuddy）。
#     -Phase collect   给 agent 的问题集：每项标明谁能回答、缺了卡在哪节、格式怎么校验。
#     -Phase check     校验 answers 是否齐全且格式对；齐了才开始跑 11/8 个阶段。
#
# 答案唯一落盘位置：<Root>\data\deploy-answers.json。
# 后续 dirs / files / org / wecom / bind 各阶段都从这里读，不再各自问一遍。
# **webhook 只存文件名，不存明文**：明文留在 <Root>\secrets\，那里 ACL 已收紧。
#
# 退出码：0 通过（含 identity/prepare/collect 正常输出）/ 1 check 有缺项或格式错 / 2 用法错误

[CmdletBinding()]
param(
    [ValidateSet('identity', 'prepare', 'collect', 'check')]
    [string]$Phase = 'identity',

    # side 由 -Phase identity 的答案推出；identity 之外的阶段必须显式给。
    [ValidateSet('company', 'employee')]
    [string]$Side = '',

    # 安装人身份：boss / it / employee / helper。只用于把答案记全，不改变 side 的推导。
    [ValidateSet('boss', 'it', 'employee', 'helper', '')]
    [string]$Role = '',

    [string]$Root = '',
    [string]$Answers = '',
    # 从已有的 org 目录反推 answers（重装 / 换机 / 迁移用，省掉重新填表）
    [string]$FromOrg = '',
    # -FromOrg 时覆盖已存在的 answers
    [switch]$Force,
    [switch]$Json
)

$ErrorActionPreference = 'Stop'

if (-not $Root) {
    $Root = if ($Side -eq 'employee') { Join-Path $env:LOCALAPPDATA 'anc' } else { Join-Path $env:ProgramData 'anc' }
}
if (-not $Answers) { $Answers = Join-Path $Root 'data\deploy-answers.json' }

function Fail([string]$msg, [string]$fix, [int]$code) {
    Write-Host "ERROR $msg"
    if ($fix) { Write-Host "FIX   $fix" }
    exit $code
}

function Emit($obj, [int]$code, [string[]]$Lines = @()) {
    if ($Json) {
        try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
        $obj | ConvertTo-Json -Depth 8
    } else {
        # 逐行 Write-Output 走 stdout：Write-Host 在 PS 5.1 里重定向到管道时会丢掉换行，
        # agent 用 2>&1 捕获后整段粘成一行（实测踩过，看起来像文案没分段）。
        foreach ($l in $Lines) { Write-Output $l }
    }
    exit $code
}

# ── 身份表：身份 → side。这是整个流程的第一个问题 ─────────────────────────
# 为什么不让人自己选 company/employee：这两个词是我们的内部术语，装的人不知道自己是哪种。
# 「你是给自己装还是给全公司装」是人的语言，映射由这里做。
$Roles = @(
    [pscustomobject]@{
        role  = 'boss'
        label = '我是老板 / 负责人，要在公司那台常开的机器上装公司 bot'
        side  = 'company'
        why   = '公司侧：要求管理员权限、注册 14 个计划任务、建两区 vault、配企微后台。这台机器要 7×24 开着。'
    },
    [pscustomobject]@{
        role  = 'it'
        label = '我是公司 IT / 管理员，负责装或重装公司主机'
        side  = 'company'
        why   = '公司侧：同老板那条，但通常还要处理重装、回滚和账号。'
    },
    [pscustomobject]@{
        role  = 'employee'
        label = '我是员工，要在自己的办公电脑上装个人 bot'
        side  = 'employee'
        why   = '员工侧：不要求管理员权限、不注册计划任务、不建 vault，只读公司共享区。'
    },
    [pscustomobject]@{
        role  = 'helper'
        label = '我在帮同事装，装的是他那台电脑'
        side  = 'employee'
        why   = '员工侧：同员工那条，但成员 id / userid / chatId 必须问本人，不能猜。装错人不会报错，只会让 bot 去服务别人。'
    }
)

# ── 给人看的准备清单 ────────────────────────────────────────────────────────
function Get-PrepareItems([string]$s) {
    $companyItems = @(
        [pscustomobject]@{
            id = 'workbuddy'; do = '装一个**空的** WorkBuddy 并登录企业微信'
            check = 'WorkBuddy 能打开、左上角是已登录状态；装完不要配任何东西'
            why = 'persona 和补丁都靠后面步骤注入，先配过的东西会被覆盖'
            blocks = '§2 workbuddy（这一步只有人能做的，agent 装不了）'
        },
        [pscustomobject]@{
            id = 'groups'; do = '把要用的群建好，并把 bot 拉进去'
            check = '至少一个群；四类群是：员工群、部门群、公司大群、老板 1:1'
            why = '没有群就拿不到 chatId，任务提醒和出站消息都发不出去'
            blocks = '§8 tasks、§11 wecom'
        },
        [pscustomobject]@{
            id = 'chatid'; do = '每个群打开「群设置」，抄下 chatId（32 字符，别截断）'
            check = '长度是 32；只抄前 8 位或带空格都不行'
            why = 'chatId 是群的身份，绑错了 bot 认不出群，而且不会报错'
            blocks = '§10 org、§11 wecom'
        },
        [pscustomobject]@{
            id = 'webhook'; do = '每个群加一个群机器人，拿到 webhook 地址'
            check = '形如 https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…'
            why = '主动推送（提醒、告警）走 webhook；没有它只能被动回话'
            blocks = '§10.5 webhook 文件、§11 wecom'
        },
        [pscustomobject]@{
            id = 'staff'; do = '准备人员名单：姓名、英文 id、企微账号、部门、角色'
            check = '英文 id 只用小写字母/数字/下划线/连字符；每个人都要有企微账号'
            why = 'persona 和权限都从名单生成；缺 userid 的人 bot 认不出来'
            blocks = '§10 org'
        },
        [pscustomobject]@{
            id = 'admin'; do = '确认你有这台机器的管理员权限'
            check = '能「以管理员身份运行」PowerShell'
            why = '注册计划任务、写 ProgramData、设 ACL 都要管理员'
            blocks = '§3 preflight、§8 tasks、§9 vault'
        }
    )
    $employeeItems = @(
        [pscustomobject]@{
            id = 'own'; do = '确认这台电脑是你自己的（不是共用的）'
            check = '如果是共用电脑，停下来，别装'
            why = '个人 bot 用你的身份工作；共用电脑等于让别人也能用你的身份'
            blocks = '§1（这是前提，不满足就不该继续）'
        },
        [pscustomobject]@{
            id = 'workbuddy'; do = '确认 WorkBuddy 已装好并登录企业微信'
            check = 'WorkBuddy 正在跑，能收到群消息'
            why = '个人 bot 就跑在 WorkBuddy 里，不需要另装'
            blocks = '§3 workbuddy'
        },
        [pscustomobject]@{
            id = 'chatid'; do = '打开你所在的那个群，抄下 chatId（32 字符）'
            check = '长度是 32；别截断'
            why = '绑定用；截断值会被静默接受，然后 bot 认不出群'
            blocks = '§7 bind'
        },
        [pscustomobject]@{
            id = 'userid'; do = '从公司侧拿到你的企微 userid'
            check = '不是你名字、不是手机号；公司侧给的那串'
            why = 'persona 靠它认主人；认错了 bot 会服务别人'
            blocks = '§6 persona'
        },
        [pscustomobject]@{
            id = 'shared'; do = '问公司侧要共享区路径'
            check = '形如 \\\\主机\\anc-vault-shared 或 D:\\anc\\vault-shared'
            why = '只读公司资料用；读不到不影响装完，但 vault-read 这项验不过'
            blocks = '§8 verify（vault-read）'
        }
    )
    if ($s -eq 'company') { return $companyItems } else { return $employeeItems }
}

# ── 给 agent 的问题集 ───────────────────────────────────────────────────────
# who: installer=必须问人 / self=agent 自己查 / optional=有就更好
function Get-Questions([string]$s) {
    if ($s -eq 'company') {
        return @(
            [pscustomobject]@{
                id = 'company.name'; ask = '公司叫什么名字'; who = 'installer'; required = $true
                format = '非空字符串'; blocks = '§10 org（persona 抬头和指纹都用到）'
                hint = '写全称，会出现在 persona 第一行'
            },
            [pscustomobject]@{
                id = 'company.vaultRoot'; ask = 'vault 两区放在哪个目录'; who = 'installer'; required = $true
                format = '绝对路径且带盘符，盘必须存在'; blocks = '§9 vault'
                hint = '默认 D:\anc；要一块容量够的盘，vault 会长'
            },
            [pscustomobject]@{
                id = 'groups'; ask = '有哪些群？每个群的类型、chatId、webhook 文件名'; who = 'installer'; required = $true
                format = '数组，每项字段见下'; type = 'array'
                itemFields = @(
                    [pscustomobject]@{ key = 'type'; format = 'employee / department / company / boss_dm' },
                    [pscustomobject]@{ key = 'name'; format = '群名称，给人看的' },
                    [pscustomobject]@{ key = 'chatId'; format = '32 字符' },
                    [pscustomobject]@{ key = 'webhookFile'; format = '只能是文件名，如 zhangsan-bot.txt（不存明文地址）' }
                )
                blocks = '§8 tasks、§10.5 webhook、§11 wecom'
                hint = '四类群里没有配的不会生成产物，可以先只配员工群 + 公司大群'
            },
            [pscustomobject]@{
                id = 'members'; ask = '有哪些人？每个人的姓名、英文 id、企微账号、部门、角色'; who = 'installer'; required = $true
                format = '数组，每项字段见下'; type = 'array'
                itemFields = @(
                    [pscustomobject]@{ key = 'id'; format = '小写字母/数字/下划线/连字符，如 guoshuai' },
                    [pscustomobject]@{ key = 'name'; format = '姓名' },
                    [pscustomobject]@{ key = 'userid'; format = '企微 AI Bot 上报的 wok… 值，不是通讯录账号（见 §10.4）' },
                    [pscustomobject]@{ key = 'dept'; format = '部门 id，要和 depts/ 里的一致' },
                    [pscustomobject]@{ key = 'role'; format = 'owner / manager / employee（老板的 role 是 owner，**不是 boss**——org/roles 里就是 owner.md）' },
                    [pscustomobject]@{ key = 'chatId'; format = '这个人的员工群 chatId（可选）' }
                )
                blocks = '§10 org'
                hint = 'userid 拿不准就先留空，装完让本人发一条消息，用 bind-member-identity 回填'
            }
        )
    }
    return @(
        [pscustomobject]@{
            id = 'employee.memberId'; ask = '你在公司 org 里是哪个成员 id'; who = 'installer'; required = $true
            format = '小写字母/数字/下划线/连字符'; blocks = '§6 persona（装错就是装了别人的身份）'
            hint = '这个必须问人，不能从 render\members 里猜；多个成员共用同一个 userid 时更猜不出来'
        },
        [pscustomobject]@{
            id = 'employee.userid'; ask = '你的企微 userid'; who = 'installer'; required = $true
            format = '非空字符串'; blocks = '§6 persona、§7 bind'
            hint = '不是姓名、不是手机号'
        },
        [pscustomobject]@{
            id = 'employee.chatId'; ask = '你的群 chatId'; who = 'installer'; required = $true
            format = '32 字符'; blocks = '§7 bind'
            hint = '截断值会被静默接受，绑完 bot 认不出群'
        },
        [pscustomobject]@{
            id = 'employee.vaultShared'; ask = '公司共享区路径'; who = 'optional'; required = $false
            format = 'UNC 或绝对路径'; blocks = '§8 verify（vault-read）'
            hint = '已经同步过 org\company.md 就能自己读 vault_shared，读不到再问'
        },
        [pscustomobject]@{
            id = 'employee.companyBotName'; ask = '公司 bot 叫什么'; who = 'optional'; required = $false
            format = '字符串'; blocks = '§6 persona'
            hint = '渲染产物里有；拿不到就让公司侧给'
        },
        [pscustomobject]@{
            id = 'employee.dept'; ask = '你在哪个部门'; who = 'optional'; required = $false
            format = '字符串'; blocks = '§6 persona 的技能集与可见范围'
            hint = '不给就按「未分部门」处理：能用，但范围没收窄'
        }
    )
}

function Read-Answers {
    if (-not (Test-Path $Answers)) { return $null }
    try {
        $raw = [IO.File]::ReadAllText($Answers, [Text.Encoding]::UTF8).TrimStart([char]0xFEFF)
        return ($raw | ConvertFrom-Json)
    } catch { return $null }
}

# ── identity ────────────────────────────────────────────────────────────────
if ($Phase -eq 'identity') {
    $obj = [pscustomobject]@{
        phase    = 'identity'
        question = '这台机器是谁在用、要装哪一侧？'
        why      = '身份决定后面问什么、要什么权限、装几个阶段。不要让人自己选 company/employee —— 那是内部术语。'
        options  = $Roles
        next     = '按选择执行：deploy-kickoff.ps1 -Phase prepare -Side <company|employee> -Role <role>'
    }
    $lines = @()
    $lines += '【第一问】这台机器是谁在用、要装哪一侧？'
    $lines += ' '
    foreach ($r in $Roles) {
        $lines += '  [' + $r.role + '] ' + $r.label
        $lines += '        → 装 ' + $r.side + ' 侧。' + $r.why
    }
    $lines += ' '
    $lines += '注意：装公司侧要求**以管理员身份打开 WorkBuddy**（UAC 点「是」）。选 employee 则不需要——写的是你自己的目录。'
    $lines += '选一个告诉我，我会先给你一份「你现在要去做的事」清单，做完再来找我收信息。'
    Emit $obj 0 $lines
}

# 从 org 反推只可能是公司侧（org 只有公司侧才有），不强制人再传 -Side
if (-not $Side -and $Phase -eq 'collect' -and $FromOrg) { $Side = 'company' }

if (-not $Side) { Fail '缺少 -Side' '先跑 -Phase identity 拿身份选项，再用 -Side company|employee 继续' 2 }

# ── prepare ─────────────────────────────────────────────────────────────────
if ($Phase -eq 'prepare') {
    $items = @(Get-PrepareItems $Side)
    $obj = [pscustomobject]@{
        phase = 'prepare'
        side  = $Side
        title = if ($Side -eq 'company') { '公司主机部署 · 装之前你要做的事' } else { '个人电脑部署 · 装之前你要做的事' }
        items = $items
        next  = '这些做完（或确认已经做过）之后，回来告诉我，我再问你几个只有你知道的信息。'
    }
    $lines = @()
    $lines += '【' + $obj.title + '】'
    $lines += ' '
    $i = 0
    foreach ($it in $items) {
        $i++
        $lines += "$i. $($it.do)"
        $lines += "   怎么算做好了：$($it.check)"
        $lines += "   为什么要做：$($it.why)"
        $lines += ' '
    }
    $lines += '以上做完回我一句就行，我接着问只有你知道的那几个信息。'
    Emit $obj 0 $lines
}

# ── collect ─────────────────────────────────────────────────────────────────
# 从已有 org 反推 answers：重装 / 换机 / 迁移时用，避免把同样的表再填一遍。
# 只读 org（company.md + members/*.md + depts/*.md），不碰 vault、不碰库。
function Read-Frontmatter([string]$path) {
    $t = [IO.File]::ReadAllText($path, [Text.Encoding]::UTF8).TrimStart([char]0xFEFF)
    $lines = $t -split "`r?`n"
    $in = $false
    $h = [ordered]@{}
    foreach ($l in $lines) {
        if ($l -match '^---\s*$') { if ($in) { break } else { $in = $true; continue } }
        if (-not $in) { continue }
        if ($l -match '^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$') {
            $k = $matches[1]
            $v = $matches[2].Trim()
            if ($v -match "^'(.*)'$") { $v = $matches[1] -replace "''", "'" }
            $h[$k] = $v
        }
    }
    return $h
}

if ($Phase -eq 'collect' -and $FromOrg) {
    if (-not (Test-Path $FromOrg)) { Fail ("找不到 org 目录: " + $FromOrg) '指向含 company.md 的目录，例如 D:\anc\org' 2 }
    $orgCompany = Join-Path $FromOrg 'company.md'
    if (-not (Test-Path $orgCompany)) { Fail ("org 里没有 company.md: " + $FromOrg) '确认 -FromOrg 指向 org 根（不是 members 子目录）' 2 }
    if ((Test-Path $Answers) -and -not $Force) {
        Fail ('answers 已存在: ' + $Answers) '要按 org 覆盖就加 -Force；否则先跑 -Phase check 看现有 answers 够不够' 1
    }

    $c = Read-Frontmatter $orgCompany
    # vaultRoot 从 vault_shared 的父目录推：D:\anc\vault-shared -> D:\anc
    $vaultRoot = ''
    foreach ($k in @('vault_shared', 'vault_internal')) {
        $v = [string]$c[$k]
        if ($v -and -not $vaultRoot) {
            $p = $v.TrimEnd('\')
            if ((Split-Path $p -Leaf) -in @('vault-shared', 'vault-internal')) { $vaultRoot = Split-Path $p -Parent }
        }
    }

    $groups = @()
    if ($c['company_group_chat_id']) {
        $groups += [pscustomobject]@{ type = 'company'; name = '公司大群'; chatId = [string]$c['company_group_chat_id']; webhookFile = [string]$c['company_group_webhook_file'] }
    }
    if ($c['boss_dm_chat_id']) {
        $groups += [pscustomobject]@{ type = 'boss_dm'; name = '老板 1:1'; chatId = [string]$c['boss_dm_chat_id']; webhookFile = [string]$c['boss_dm_webhook_file'] }
    }

    $members = @()
    $membersDir = Join-Path $FromOrg 'members'
    if (Test-Path $membersDir) {
        foreach ($f in @(Get-ChildItem $membersDir -File -Filter '*.md' | Sort-Object Name)) {
            $m = Read-Frontmatter $f.FullName
            $members += [pscustomobject]@{
                id     = $(if ($m['id']) { [string]$m['id'] } else { $f.BaseName })
                name   = [string]$m['name']
                role   = [string]$m['role']
                userid = [string]$m['userid']
                dept   = [string]$m['dept']
                manages = [string]$m['manages']
            }
        }
    }

    $depts = @()
    $deptsDir = Join-Path $FromOrg 'depts'
    if (Test-Path $deptsDir) {
        foreach ($f in @(Get-ChildItem $deptsDir -File -Filter '*.md' | Sort-Object Name)) {
            $d = Read-Frontmatter $f.FullName
            $depts += [pscustomobject]@{ id = $(if ($d['id']) { [string]$d['id'] } else { $f.BaseName }); name = [string]$d['name'] }
        }
    }

    $ans = [ordered]@{
        schema    = 1
        side      = 'company'
        company   = [ordered]@{
            name           = [string]$c['name']
            companyBotName = [string]$c['company_bot_name']
            vaultRoot      = $vaultRoot
            localWorkdir   = [string]$c['local_workdir']
        }
        groups    = @($groups)
        depts     = @($depts)
        members   = @($members)
        collectedAt = (Get-Date).ToString('o')
        derivedFrom = $FromOrg
    }

    $dir = Split-Path -Parent $Answers
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    [IO.File]::WriteAllText($Answers, ($ans | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding($false)))

    $obj = [pscustomobject]@{
        phase       = 'collect'
        side        = 'company'
        derivedFrom = $FromOrg
        answersPath = $Answers
        counts      = [pscustomobject]@{ groups = @($groups).Count; members = @($members).Count; depts = @($depts).Count }
        next        = '已按 org 反推。跑 -Phase check 校验；userid 为空的人装完要让人发一条消息回填。'
    }
    $lines = @()
    $lines += '=== 已从 org 反推 answers ==='
    $lines += ('来源: ' + $FromOrg)
    $lines += ('写入: ' + $Answers)
    $lines += ('群 ' + @($groups).Count + ' / 成员 ' + @($members).Count + ' / 部门 ' + @($depts).Count)
    if (-not $vaultRoot) { $lines += '注意：company.md 里没有 vault_shared/vault_internal，vaultRoot 空着，要手填。' }
    $noUid = @($members | Where-Object { -not $_.userid })
    if ($noUid.Count -gt 0) { $lines += ('提醒：' + $noUid.Count + ' 个成员没有 userid（' + (($noUid | ForEach-Object { $_.id }) -join ', ') + '），装完让他们各发一条消息再回填。') }
    $lines += ''
    $lines += ('NEXT  ' + $obj.next)
    Emit $obj 0 $lines
}

if ($Phase -eq 'collect') {
    $qs = @(Get-Questions $Side)
    $obj = [pscustomobject]@{
        phase       = 'collect'
        side        = $Side
        role        = $Role
        answersPath = $Answers
        howto       = '把答案写进 answersPath（或告诉我，我写）。who=installer 的必须问人；who=self 的我先自己查，查不到再问；who=optional 的缺了也能装。'
        questions   = $qs
        next        = '答案齐了跑：-Phase check -Side ' + $Side
    }
    $lines = @()
    $lines += '=== 要收集的信息（' + $Side + ' 侧）==='
    $lines += '答案落到：' + $Answers
    $lines += '规矩：who=installer 必须问人；who=self 我自己查，查不到再问；who=optional 缺了也能装。'
    $lines += ' '
    $i = 0
    foreach ($q in $qs) {
        $i++
        $tag = if ($q.required) { '必填' } else { '可缺' }
        $lines += "$i. [$tag · $($q.who)] $($q.id)"
        $lines += '   问：' + $q.ask
        $lines += '   格式：' + $q.format
        $lines += '   缺了卡在：' + $q.blocks
        if ($q.hint) { $lines += '   提示：' + $q.hint }
        if ($q.itemFields) {
            $lines += '   每一项包含：'
            foreach ($f in $q.itemFields) { $lines += '     - ' + $f.key + '：' + $f.format }
        }
        $lines += ' '
    }
    $lines += 'NEXT  ' + $obj.next
    Emit $obj 0 $lines
}

# ── check ───────────────────────────────────────────────────────────────────
$errors = @()
$warns = @()
function Add-Err([string]$p, [string]$why) { $script:errors += [pscustomobject]@{ path = $p; why = $why } }
function Add-Warn([string]$p, [string]$why) { $script:warns += [pscustomobject]@{ path = $p; why = $why } }

$a = Read-Answers
if ($null -eq $a) {
    Add-Err 'answers' "读不到或解析失败: $Answers"
} else {
    if ($a.side -and $a.side -ne $Side) { Add-Warn 'side' ("文件里写的是 " + $a.side + "，本次按 " + $Side + " 校验") }

    if ($Side -eq 'company') {
        if (-not $a.company -or -not $a.company.name) { Add-Err 'company.name' '公司名为空（§10 org 会缺抬头）' }
        $vr = if ($a.company) { [string]$a.company.vaultRoot } else { '' }
        if (-not $vr) {
            Add-Err 'company.vaultRoot' 'vault 目录为空（§9 建不了两区）'
        } else {
            $q = ''
            try { $q = Split-Path -Qualifier $vr } catch { }
            if (-not $q) { Add-Err 'company.vaultRoot' "不是带盘符的绝对路径: $vr" }
            elseif (-not (Test-Path ($q + '\'))) { Add-Err 'company.vaultRoot' "盘不存在: $q" }
        }

        $gs = @($a.groups)
        if ($gs.Count -eq 0 -or -not $a.groups) {
            Add-Err 'groups' '一个群都没有（§8 任务提醒、§11 出站都发不出去）'
        } else {
            $i = 0
            foreach ($g in $gs) {
                if (-not $g.type) { Add-Err "groups[$i].type" '缺群类型' }
                elseif (@('employee', 'department', 'company', 'boss_dm') -notcontains $g.type) { Add-Err "groups[$i].type" ("未知群类型: " + $g.type) }
                $cid = [string]$g.chatId
                if (-not $cid) { Add-Err "groups[$i].chatId" '缺 chatId' }
                elseif ($cid.Trim().Length -ne 32) { Add-Warn "groups[$i].chatId" ("长度 " + $cid.Trim().Length + '，约定 32（截断值会被静默接受，绑完 bot 认不出群）') }
                if ($g.webhookFile -and ($g.webhookFile -match '[\\/]')) { Add-Err "groups[$i].webhookFile" '只能写文件名，不要写路径，更不要写 webhook 明文' }
                $i++
            }
        }

        $ms = @($a.members)
        if ($ms.Count -eq 0 -or -not $a.members) {
            Add-Err 'members' '一个成员都没有（§10 org 生成不了 persona）'
        } else {
            $i = 0
            $seen = @()
            $ownerCount = 0
            foreach ($m in $ms) {
                if (-not $m.id) { Add-Err "members[$i].id" '缺成员 id' }
                # 必须用 -cnotmatch（区分大小写）：PowerShell 的 -notmatch 默认忽略大小写，
                # "ZhangSan" 会通过 ^[a-z0-9_-]+$ 检查，然后装出一个带大写的成员目录。
                elseif ($m.id -cnotmatch '^[a-z0-9_-]+$') { Add-Err "members[$i].id" ("id 只能用小写字母/数字/下划线/连字符: " + $m.id) }
                elseif ($seen -contains $m.id) { Add-Err "members[$i].id" ("重复的 id: " + $m.id) }
                else { $seen += $m.id }
                if (-not $m.name) { Add-Warn "members[$i].name" '缺姓名' }
                if (-not $m.userid) { Add-Warn "members[$i].userid" '缺企微 userid（装完可让本人发消息回填，不进 org 前 bot 认不出他）' }
                if (-not $m.dept) { Add-Warn "members[$i].dept" '缺部门' }
                if ($m.role -eq 'owner') { $ownerCount++ }
                $i++
            }
            if ($ownerCount -eq 0) { Add-Warn 'members' '没有 role=owner 的成员（老板 1:1 群和隐私路由会缺一个目标）' }
            if ($ownerCount -gt 1) { Add-Warn 'members' ('role=owner 有 ' + $ownerCount + ' 个，确认是否故意') }
        }
    } else {
        $e = $a.employee
        if (-not $e) {
            Add-Err 'employee' '整段缺失（员工侧至少要有 memberId / userid / chatId）'
        } else {
            if (-not $e.memberId) { Add-Err 'employee.memberId' '缺成员 id（装错就是装了别人的身份）' }
            elseif ($e.memberId -cnotmatch '^[a-z0-9_-]+$') { Add-Err 'employee.memberId' ("id 只能用小写字母/数字/下划线/连字符: " + $e.memberId) }
            if (-not $e.userid) { Add-Err 'employee.userid' '缺企微 userid（persona 认不出主人）' }
            $cid = [string]$e.chatId
            if (-not $cid) { Add-Err 'employee.chatId' '缺群 chatId（§7 bind 绑不了）' }
            elseif ($cid.Trim().Length -ne 32) { Add-Warn 'employee.chatId' ("长度 " + $cid.Trim().Length + '，约定 32') }
        }
    }
}

$ok = ($errors.Count -eq 0)
$next = if (-not $ok) {
    '有 ' + $errors.Count + ' 项必须补齐（看 errors）；补齐后重跑 -Phase check。'
} elseif ($warns.Count -gt 0) {
    '必须项齐了，但有 ' + $warns.Count + ' 项提醒。可以开始装；这些提醒会在对应阶段变成 WARN 或功能缺失。'
} else {
    '全部通过。开始装：-Side ' + $Side + '，按 docs/DEPLOY-' + $(if ($Side -eq 'company') { 'COMPANY' } else { 'EMPLOYEE' }) + '.md 从 brief 阶段往下跑。'
}

$out = [pscustomobject]@{
    phase       = 'check'
    side        = $Side
    ok          = $ok
    answersPath = $Answers
    errors      = $errors
    warnings    = $warns
    next        = $next
}

$lines = @()
$lines += '=== deploy-kickoff check (' + $Side + ') ==='
$lines += 'answers: ' + $Answers
$lines += ' '
if ($errors.Count -gt 0) {
    $lines += '必须补（' + $errors.Count + '）：'
    foreach ($e in $errors) { $lines += '  x ' + $e.path + '  ' + $e.why }
    $lines += ' '
}
if ($warns.Count -gt 0) {
    $lines += '提醒（' + $warns.Count + '）：'
    foreach ($w in $warns) { $lines += '  ! ' + $w.path + '  ' + $w.why }
    $lines += ' '
}
$lines += 'NEXT  ' + $next

Emit $out $(if ($ok) { 0 } else { 1 }) $lines
