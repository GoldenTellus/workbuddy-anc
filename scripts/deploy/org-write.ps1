# 从 deploy-answers.json 生成 org 目录（company.md / members / depts / roles）。
#
# 为什么要有这一步：
#   公司侧 §10 现在是「人手写 company.md + 每个人一份 members/<id>.md + depts/*.md」。
#   人一多就是十几份 frontmatter，字段漏一个、拼错一个，render 那边才会报，
#   而且报的是"引用了不存在的部门"这种离现场很远的错误。
#   这些字段在访谈阶段已经全问过了（deploy-kickoff -Phase collect），没有理由再手抄一遍。
#
# 安全策略（重要）：
#   **默认不覆盖已存在的文件。** org 是运行数据，可能有人手改过（补 userid、改 manages）。
#   已存在且内容不同的文件会被列为 conflict 并跳过；确认要以 answers 为准时再加 -Force。
#   这样「重跑一次」不会把人手补的东西冲掉。
#
# 用法：
#   org-write.ps1 -Side company -VaultRoot D:\anc            # 生成（不覆盖）
#   org-write.ps1 -Side company -VaultRoot D:\anc -Force     # 以 answers 为准覆盖
#   org-write.ps1 -Side company -VaultRoot D:\anc -Json      # 给 agent 解析
#
# 退出码：0 成功（含"全部已存在、无需改动"）/ 1 数据不完整或冲突需 -Force / 2 用法错误

[CmdletBinding()]
param(
    [string]$Answers = '',
    [string]$Root = '',
    [string]$VaultRoot = '',
    [string]$Repo = '',
    [switch]$Force,
    [switch]$DryRun,
    [switch]$Json
)

$ErrorActionPreference = 'Stop'

if (-not $Root) { $Root = Join-Path $env:ProgramData 'anc' }
if (-not $Answers) { $Answers = Join-Path $Root 'data\deploy-answers.json' }
if (-not $VaultRoot) { $VaultRoot = 'D:\anc' }
# org 与 vault 两区同级：D:\anc\{org, vault-shared, vault-internal}
$OrgRoot = Join-Path $VaultRoot 'org'
if (-not $Repo) {
    $c = $PSScriptRoot
    while ($c -and -not (Test-Path (Join-Path $c '.git'))) {
        $p = Split-Path -Parent $c
        if ($p -eq $c) { break }
        $c = $p
    }
    $Repo = $c
}

$created = @(); $updated = @(); $skipped = @(); $conflicts = @(); $errors = @()

function Finish([int]$code) {
    $ok = ($errors.Count -eq 0 -and $conflicts.Count -eq 0)
    if ($conflicts.Count -gt 0 -and -not $Force) { $code = 1 }
    $obj = [ordered]@{
        # ok 必须把 conflict 也算进去：有冲突 = 没按 answers 对齐，agent 不能当成功
        ok        = $ok
        orgRoot   = $OrgRoot
        created   = @($created)
        updated   = @($updated)
        skipped   = @($skipped)
        conflicts = @($conflicts)
        errors    = @($errors)
        next      = if ($conflicts.Count -gt 0 -and -not $Force) {
            '有 ' + $conflicts.Count + ' 个文件已存在且内容不同（可能手改过）。确认要以 answers 为准就加 -Force。'
        } elseif ($errors.Count -gt 0) { '先修 errors，再重跑。' } else { 'org 已生成。接着跑 render + deploy-persona（DEPLOY-COMPANY §10.6）。' }
    }
    if ($Json) {
        try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
        $obj | ConvertTo-Json -Depth 6
    } else {
        foreach ($e in $errors) { Write-Output ('ERROR  ' + $e) }
        foreach ($c in $conflicts) { Write-Output ('CONFLICT ' + $c) }
        Write-Output ''
        Write-Output ('org 根: ' + $OrgRoot)
        Write-Output ('新建 ' + $created.Count + ' / 更新 ' + $updated.Count + ' / 跳过 ' + $skipped.Count + ' / 冲突 ' + $conflicts.Count)
        Write-Output ''
        Write-Output ('NEXT  ' + $obj.next)
    }
    exit $code
}

if (-not (Test-Path $Answers)) {
    $errors += ('找不到 answers: ' + $Answers + '（先跑 deploy-kickoff -Phase collect/check）')
    Finish 1
}

$a = $null
try {
    $a = [IO.File]::ReadAllText($Answers, [Text.Encoding]::UTF8).TrimStart([char]0xFEFF) | ConvertFrom-Json
} catch {
    $errors += ('answers 解析失败: ' + $_.Exception.Message)
    Finish 1
}

if ($a.side -and $a.side -ne 'company') {
    $errors += ('这份 answers 的 side 是 ' + $a.side + '；org-write 只用于公司侧')
    Finish 1
}

# ── 校验（不完整就别写，写一半比不写更糟）────────────────────────────────
if (-not $a.company -or -not $a.company.name) { $errors += 'company.name 为空' }
$members = @($a.members)
if ($members.Count -eq 0) { $errors += 'members 为空' }
$owners = @($members | Where-Object { $_.role -eq 'owner' })
if ($owners.Count -eq 0) { $errors += '没有 role=owner 的成员（company.md 的 boss 字段没得填）' }
if ($owners.Count -gt 1) { $errors += ('role=owner 有 ' + $owners.Count + ' 个，只能有一个') }
foreach ($m in $members) {
    if (-not $m.id) { $errors += '有成员缺 id' }
    if ($m.role -and @('owner', 'manager', 'employee') -notcontains $m.role) {
        $errors += ('成员 ' + $m.id + ' 的 role=' + $m.role + ' 不认识（只能是 owner/manager/employee）')
    }
}
if ($errors.Count -gt 0) { Finish 1 }

# ── 写文件的公共逻辑：存在且不同 → 记冲突；-Force 才覆盖 ──────────────────
function Write-OrgFile([string]$path, [string]$content) {
    $rel = $path.Substring($OrgRoot.Length).TrimStart('\')
    if (Test-Path $path) {
        $old = [IO.File]::ReadAllText($path, [Text.Encoding]::UTF8)
        if ($old.TrimEnd() -eq $content.TrimEnd()) { $script:skipped += $rel; return }
        if (-not $Force) { $script:conflicts += ($rel + '（已存在且内容不同）'); return }
        if (-not $DryRun) { [IO.File]::WriteAllText($path, $content, (New-Object Text.UTF8Encoding($false))) }
        $script:updated += $rel
        return
    }
    if (-not $DryRun) {
        $dir = Split-Path -Parent $path
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        [IO.File]::WriteAllText($path, $content, (New-Object Text.UTF8Encoding($false)))
    }
    $script:created += $rel
}

# YAML 值：含特殊字符时加单引号，避免 frontmatter 被解析歪
function YamlVal([string]$v) {
    if ($null -eq $v) { return "''" }
    if ($v -match '[:#]' -or $v -match '^\s|\s$' -or $v -eq '' -or $v -match '^[>\|\[\]\{\}\*\&\!]') {
        return "'" + ($v -replace "'", "''") + "'"
    }
    return $v
}

# ── company.md ─────────────────────────────────────────────────────────────
$groups = @($a.groups)
$gCompany = @($groups | Where-Object { $_.type -eq 'company' }) | Select-Object -First 1
$gBossDm = @($groups | Where-Object { $_.type -eq 'boss_dm' }) | Select-Object -First 1
$botName = if ($a.company.companyBotName) { $a.company.companyBotName } else { '公司bot' }
$localWorkdir = if ($a.company.localWorkdir) { $a.company.localWorkdir } else { "$env:USERPROFILE\WorkBuddy\Claw" }

$companyLines = @(
    '---'
    ('name: ' + (YamlVal $a.company.name))
    ('company_bot_name: ' + (YamlVal $botName))
    ('boss: ' + $owners[0].id)
    ('company_group_chat_id: ' + (YamlVal $(if ($gCompany) { [string]$gCompany.chatId } else { '' })))
    ('company_group_webhook_file: ' + (YamlVal $(if ($gCompany) { [string]$gCompany.webhookFile } else { '' })))
    ('boss_dm_chat_id: ' + (YamlVal $(if ($gBossDm) { [string]$gBossDm.chatId } else { '' })))
    ('boss_dm_webhook_file: ' + (YamlVal $(if ($gBossDm) { [string]$gBossDm.webhookFile } else { '' })))
    ('vault_shared: ' + (YamlVal (Join-Path $VaultRoot 'vault-shared')))
    ('vault_internal: ' + (YamlVal (Join-Path $VaultRoot 'vault-internal')))
    ('local_workdir: ' + (YamlVal $localWorkdir))
    '---'
)
Write-OrgFile (Join-Path $OrgRoot 'company.md') (($companyLines -join "`n") + "`n")

# ── roles/*.md：固定三份，从 org.example 复制 ─────────────────────────────
# 三份缺一不可：render 按成员的 role 去 roles\ 里找，找不到就报「引用了不存在的角色」。
# 2026-11-10 实测踩到：org.example\roles 原来只有 manager.md，生成的 org 会让
# owner / employee 的成员全部认不出角色 —— 所以这里先校验，再复制。
$rolesSrc = Join-Path $Repo 'org.example\roles'
$requiredRoles = @('owner', 'manager', 'employee')
$missingRoles = @($requiredRoles | Where-Object { -not (Test-Path (Join-Path $rolesSrc ($_ + '.md'))) })
if ($missingRoles.Count -gt 0) {
    $errors += ('org.example\roles 缺角色模板: ' + ($missingRoles -join ', ') + '（仓库里补齐再跑；缺角色的成员 render 时会报错）')
} else {
    foreach ($f in @(Get-ChildItem $rolesSrc -File -Filter '*.md')) {
        Write-OrgFile (Join-Path (Join-Path $OrgRoot 'roles') $f.Name) ([IO.File]::ReadAllText($f.FullName, [Text.Encoding]::UTF8))
    }
}

# ── members/<id>.md ────────────────────────────────────────────────────────
foreach ($m in $members) {
    $lines = @('---')
    $lines += ('id: ' + $m.id)
    $lines += ('name: ' + (YamlVal $m.name))
    $lines += ('role: ' + $(if ($m.role) { $m.role } else { 'employee' }))
    $lines += ('userid: ' + (YamlVal ([string]$m.userid)))
    if ($m.dept) { $lines += ('dept: ' + $m.dept) }
    if ($m.manages) { $lines += ('manages: ' + $m.manages) }
    $lines += ('seat: ' + $(if ($m.seat) { $m.seat } else { 'Enterprise' }))
    $lines += ('bot: ' + (YamlVal $(if ($m.bot) { $m.bot } else { '待接入' })))
    $lines += '---'
    Write-OrgFile (Join-Path (Join-Path $OrgRoot 'members') ($m.id + '.md')) (($lines -join "`n") + "`n")
}

# ── depts/<id>.md：从成员的 dept 去重生成；name/skills 缺失就留空 ─────────
$deptMap = [ordered]@{}
foreach ($d in @($a.depts)) { if ($d.id) { $deptMap[$d.id] = $d } }
foreach ($m in $members) {
    if ($m.dept -and -not $deptMap.Contains($m.dept)) { $deptMap[$m.dept] = [pscustomobject]@{ id = $m.dept } }
}
foreach ($id in $deptMap.Keys) {
    $d = $deptMap[$id]
    $lines = @('---')
    $lines += ('id: ' + $id)
    $lines += ('name: ' + (YamlVal $(if ($d.name) { $d.name } else { $id })))
    if ($d.vaultPaths) {
        $lines += 'vault_paths:'
        foreach ($p in @($d.vaultPaths)) { $lines += ('  - ' + (YamlVal $p)) }
    } else { $lines += 'vault_paths: []' }
    if ($d.skills) {
        $lines += 'skills:'
        foreach ($s in @($d.skills)) { $lines += ('  - ' + $s) }
    } else { $lines += 'skills: []' }
    if ($d.note) { $lines += ('note: ' + (YamlVal $d.note)) }
    $lines += '---'
    Write-OrgFile (Join-Path (Join-Path $OrgRoot 'depts') ($id + '.md')) (($lines -join "`n") + "`n")
}

Finish 0
