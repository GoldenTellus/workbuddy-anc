# 员工侧本地自举：安装人访谈 → 本地生成个人 persona（不依赖公司侧 render/groups）
#
# 背景（2026-11-12 修正）：
#   - 员工 bot 不读公司主机上的库；公司资料/任务由主人在员工群 @ 公司 bot。
#   - 因此员工侧不再需要公司侧同步 render/groups.json、org/company.md、render/members/<id>。
#   - 只需要安装人回答：memberId / name / userid / 员工群 chatId / 公司名 / 公司 bot 名 /
#     部门 / 本机工作目录。本脚本用这些字段 + 仓库模板生成本地 persona。
#
# 用法：
#   powershell -File scripts\deploy\employee-bootstrap.ps1 -Repo <仓库>            # dry-run
#   powershell -File scripts\deploy\employee-bootstrap.ps1 -Repo <仓库> -Apply     # 写 persona
#
# 退出码：0 成功 / 1 输入或模板错误 / 2 用法错误

[CmdletBinding()]
param(
    [string]$Root = (Join-Path $env:LOCALAPPDATA 'anc'),
    [string]$Repo = '',
    [string]$Template = '',
    [string]$Target = "$env:USERPROFILE\WorkBuddy\Claw\CODEBUDDY.md",
    [switch]$Apply
)

$ErrorActionPreference = 'Stop'
function Fail([string]$msg, [string]$fix, [int]$code) {
    Write-Host "ERROR $msg"
    if ($fix) { Write-Host "FIX   $fix" }
    exit $code
}

if (-not $Repo) {
    $c = $PSScriptRoot
    while ($c -and -not (Test-Path (Join-Path $c '.git'))) {
        $p = Split-Path -Parent $c
        if ($p -eq $c) { break }
        $c = $p
    }
    $Repo = $c
}
if (-not $Repo -or -not (Test-Path $Repo)) { Fail '找不到仓库根' '用 -Repo 指向 workbuddy-anc 仓库' 2 }

$answers = Join-Path $Root 'data\deploy-answers.json'
if (-not (Test-Path $answers)) { Fail ('没有 answers: ' + $answers) '先让安装人回答字段并写 deploy-answers.json' 1 }

$json = [IO.File]::ReadAllText($answers, [Text.Encoding]::UTF8).TrimStart([char]0xFEFF)
try { $a = $json | ConvertFrom-Json } catch { Fail 'deploy-answers.json 不是合法 JSON' '检查嵌套 employee 结构' 1 }
$e = $a.employee
if (-not $e) { Fail '缺少 employee 段' '员工侧 answers 必须是 {"side":"employee","employee":{...}}' 1 }

foreach ($k in @('memberId', 'userid', 'chatId')) {
    if (-not [string]$e.$k) { Fail ('employee.' + $k + ' 缺失') '让安装人提供：memberId / userid / 员工群 chatId' 1 }
}
if ([string]$e.chatId -notmatch '^.{8,200}$') { Fail 'employee.chatId 太长或为空' '确认是完整员工群 chatId' 1 }

$memberId = [string]$e.memberId
$memberName = if ([string]$e.name) { [string]$e.name } else { [string]$e.userid }
$userid = [string]$e.userid
$companyName = if ([string]$e.companyName) { [string]$e.companyName } else { '公司' }
$companyBotName = if ([string]$e.companyBotName) { [string]$e.companyBotName } else { '公司bot' }
$dept = ''
if ([string]$e.deptName) { $dept = [string]$e.deptName }
elseif ([string]$e.deptId) { $dept = [string]$e.deptId }
else { $dept = '未分部门' }
$localWorkdir = if ([string]$e.localWorkdir) { [string]$e.localWorkdir } else { "$env:USERPROFILE\WorkBuddy\Claw" }

if (-not $Template) {
    $candidates = @(
        (Join-Path $Repo 'light\templates\member-bot.md'),
        (Join-Path $Root 'light\templates\member-bot.md')
    )
    $Template = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $Template -or -not (Test-Path $Template)) { Fail '找不到 member-bot.md 模板' '确认 -Repo 指向仓库；或传 -Template' 1 }

$tpl = [IO.File]::ReadAllText($Template, [Text.Encoding]::UTF8)
$fingerprint = '<!-- anc:input-sha256:' + (Get-FileHash $answers -Algorithm SHA256).Hash.ToLower() + ' -->'
$vars = @{
    fingerprint      = $fingerprint
    member_name      = $memberName
    member_id        = $memberId
    company_bot_name = $companyBotName
    owner_userid     = $userid
    member_dept      = $dept
    # 员工侧最小技能集：不装公司专用技能，也不装 anc-vault-read
    member_skills    = 'anc-dayend、anc-feedback、anc-update'
    local_workdir    = $localWorkdir
}

$text = [regex]::Replace($tpl, '\{\{([a-z0-9_]+)\}\}', {
    param($m)
    $key = $m.Groups[1].Value
    if (-not $vars.ContainsKey($key)) { throw ('模板占位符没有值: {{' + $key + '}}') }
    [string]$vars[$key]
})
if ($text -match '\{\{[^}]+\}\}') { Fail 'persona 里仍有残留占位符' '模板/字段不一致' 1 }
if ($text -match 'vault_shared|member_vault_paths|anc-vault-read') {
    Fail 'persona 仍含公司 vault/旧技能字样' '员工侧模板应已移除公司库依赖' 1
}

$renderDst = Join-Path $Root ('render\members\' + $memberId + '\CODEBUDDY.md')
Write-Host ('[employee] member=' + $memberId + ' company=' + $companyName + ' bot=' + $companyBotName)
Write-Host ('[employee] skills=' + $vars.member_skills)
Write-Host ('[employee] render=' + $renderDst)
Write-Host ('[employee] target=' + $Target)

if (-not $Apply) {
    Write-Host '[employee] dry-run；加 -Apply 才写文件'
    exit 0
}

foreach ($p in @($renderDst, $Target)) {
    $d = Split-Path -Parent $p
    if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
}
if (Test-Path $Target) {
    $backupDir = Join-Path (Split-Path -Parent $Target) '.anc-backup'
    if (-not (Test-Path $backupDir)) { New-Item -ItemType Directory -Path $backupDir -Force | Out-Null }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    Copy-Item $Target (Join-Path $backupDir ('CODEBUDDY.' + $stamp + '.md')) -Force
}
[IO.File]::WriteAllText($renderDst, $text, (New-Object Text.UTF8Encoding($false)))
[IO.File]::WriteAllText($Target, $text, (New-Object Text.UTF8Encoding($false)))
Write-Host '[employee] persona 已写入；重启 WorkBuddy 后生效'
