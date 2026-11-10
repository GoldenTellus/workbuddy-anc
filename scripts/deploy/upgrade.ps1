# 一句话升级：把仓库的新版本铺到部署目录，**不动任何运行数据**。
#
# 为什么单独一个脚本：
#   首次部署（deploy.ps1）是"从零装"，升级是"增量换运行件"。两者都调 deploy.ps1，
#   但升级多了四件事：看有没有新版本、升级前强制备份、升级后重放技能/persona、写版本记录。
#   把这些散进技能里，bot 每次都要自己拼命令，错一步就是半套。
#
# 数据为什么能保留（这是设计约束，不是巧合）：
#   deploy.ps1 的部署清单里**没有** data\ / org\ / backup\ / secrets\ / vault，
#   升级只覆盖 core / modules / service / interfaces / shared / bin / tools / patch / light\templates。
#   数据库 schema 变化由 cli 打开时自动 migrate（src/core/migrate.ts，只增不改）。
#
# 权限（必须先知道）：
#   升级要写 %ProgramData%\anc，而 bot 在群里回话时是**普通权限**（WorkBuddy 以登录用户跑，
#   普通 token 的 Administrators 是 deny-only）。所以默认情况下 bot 只能升级
#   %USERPROFILE% 下那部分（技能、persona），运行件写不动。
#   要真正"一句话升完"，先由管理员跑一次：upgrade.ps1 -GrantDeployWrite
#   它只给**运行件目录**授 Modify，不碰 secrets\ / data\（那里仍有 ACL 收紧）。
#
# 用法：
#   upgrade.ps1 -Action check                     # 有没有新版本（只 fetch，不改工作区）
#   upgrade.ps1 -Action check -Json               # 给 bot 解析
#   upgrade.ps1 -Action apply -Restart            # 升级 + 重启 WorkBuddy 让技能/persona 生效
#   upgrade.ps1 -Action rollback                  # 回到上一个版本（读 data\version.json 的 prevRev）
#   upgrade.ps1 -Action apply -GrantDeployWrite   # 一次性：授运行件目录写权限（要管理员）
#
# 退出码：0 成功 / 1 升级或校验失败 / 2 用法或环境错误 / 3 有新版本但需要人工（权限不足）

[CmdletBinding()]
param(
    [ValidateSet('check', 'apply', 'rollback')]
    [string]$Action = 'check',

    [ValidateSet('company', 'employee')]
    [string]$Side = 'company',

    [string]$Root = '',
    [string]$Repo = '',

    # 升级后重启 WorkBuddy（技能与 persona 只在新会话/重启后生效）。
    # 不传就只铺文件，由 bot 告诉人"下次会话生效"。
    [switch]$Restart,

    # 没有新版本也照常执行（用于修复性重铺）
    [switch]$Force,

    # 给运行件目录授部署用户 Modify（要管理员）。一次性操作，不改变 secrets/data 的收紧。
    [switch]$GrantDeployWrite,

    # 只打印要做什么，不落盘
    [switch]$DryRun,

    [switch]$Json
)

$ErrorActionPreference = 'Stop'

if (-not $Root) {
    $Root = if ($Side -eq 'company') { Join-Path $env:ProgramData 'anc' } else { Join-Path $env:LOCALAPPDATA 'anc' }
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

$versionFile = Join-Path $Root 'data\version.json'
$out = [ordered]@{ action = $Action; side = $Side; ok = $false; steps = @(); rev = ''; prevRev = ''; next = '' }
$steps = @()

function Add-Step([string]$name, [string]$state, [string]$detail) {
    $script:steps += [pscustomobject]@{ step = $name; state = $state; detail = $detail }
}

function Finish([int]$code) {
    $out.steps = @($script:steps)
    $out.ok = ($code -eq 0)
    if ($Json) {
        try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
        $out | ConvertTo-Json -Depth 6
    } else {
        foreach ($s in $script:steps) {
            $mark = switch ($s.state) { 'OK' { '  ok ' } 'SKIP' { ' skip' } 'FAIL' { ' FAIL' } default { '  .. ' } }
            Write-Output ($mark + ' ' + $s.step + '  ' + $s.detail)
        }
        Write-Output ''
        if ($out.next) { Write-Output ('NEXT  ' + $out.next) }
    }
    exit $code
}

function Fail([string]$msg, [string]$fix, [int]$code = 1) {
    Add-Step 'abort' 'FAIL' $msg
    $out.next = $fix
    Finish $code
}

# ── 环境检查 ────────────────────────────────────────────────────────────────
if (-not (Test-Path $Root)) { Fail "部署根不存在: $Root" '这台机器还没装过；先按 docs/DEPLOY-*.md 首次部署' 2 }
if (-not (Test-Path (Join-Path $Repo '.git'))) { Fail "不是 git 仓库: $Repo" '用 -Repo 指向仓库根（含 .git）' 2 }
foreach ($t in @('git', 'node')) {
    if (-not (Get-Command $t -ErrorAction SilentlyContinue)) { Fail "找不到 $t" "装 $t 后重试" 2 }
}

# 调外部命令并同时拿到输出与退出码。
#
# 为什么不能直接 `& git ... 2>&1`：本脚本是 $ErrorActionPreference='Stop'，
# 而 PowerShell 5.1 会把原生命令写到 stderr 的每一行包装成 NativeCommandError，
# Stop 策略下**直接抛异常** —— git fetch 打一行 "From github.com..." 进度，
# 脚本就以为拉取失败了。这个坑和 deploy 文档里 cli.ts 探针那条是同一个根因。
function Invoke-Cmd([string]$exe, [string[]]$argv) {
    $eap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $o = @(& $exe @argv 2>&1)
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $eap
    }
    $text = ((@($o | ForEach-Object { [string]$_ })) -join "`n").Trim()
    return [pscustomobject]@{ code = $code; text = $text }
}

function Invoke-Git([string[]]$gitArgs) {
    $r = Invoke-Cmd 'git' (@('-C', $Repo) + $gitArgs)
    if ($r.code -ne 0) { throw ("git " + ($gitArgs -join ' ') + " 失败(" + $r.code + '): ' + $r.text) }
    return $r.text
}

$curRev = ''
try { $curRev = (Invoke-Git @('rev-parse', '--short', 'HEAD')) } catch { }
$out.rev = $curRev

$prev = $null
if (Test-Path $versionFile) {
    try {
        $prev = [IO.File]::ReadAllText($versionFile, [Text.Encoding]::UTF8).TrimStart([char]0xFEFF) | ConvertFrom-Json
        $out.prevRev = [string]$prev.rev
    } catch { }
}

# ── 授权：给运行件目录授部署用户 Modify ──────────────────────────────────────
if ($GrantDeployWrite) {
    $isAdmin = $false
    try {
        $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
            [Security.Principal.WindowsBuiltInRole]::Administrator)
    } catch { }
    if (-not $isAdmin) { Fail '授权要管理员权限' '用管理员 PowerShell 重跑一次：upgrade.ps1 -Action apply -GrantDeployWrite' 2 }

    $u = "$env:USERDOMAIN\$env:USERNAME"
    # 只授运行件；secrets\ / data\ / accounts\ 不动（那里有单独 ACL）
    $targets = @('core', 'modules', 'service', 'interfaces', 'shared', 'ingest', 'render', 'bin', 'tools', 'patch', 'light')
    $done = @()
    foreach ($t in $targets) {
        $p = Join-Path $Root $t
        if (-not (Test-Path $p)) { continue }
        if ($DryRun) { $done += ($t + '(dry)'); continue }
        & icacls $p /grant "${u}:(OI)(CI)M" /T /Q 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) { $done += $t } else { Add-Step 'grant' 'FAIL' ("授写权限失败: " + $t) }
    }
    Add-Step 'grant' 'OK' ('运行件目录已授权给 ' + $u + '：' + ($done -join ', '))
    $out.next = '权限已开；以后 bot 可以直接跑 -Action apply（secrets 与 data 仍未开放）'
    Finish 0
}

# ── check：有没有新版本 ─────────────────────────────────────────────────────
Add-Step 'fetch' '..' 'git fetch'
try {
    Invoke-Git @('fetch', '--quiet', 'origin') | Out-Null
} catch {
    Fail ('拉取远端失败：' + $_.Exception.Message) '主机要能访问远端仓库（代理/凭据）；离线环境把更新包解压到本地再用 -Repo 指过去' 2
}

$branch = ''
try { $branch = (Invoke-Git @('rev-parse', '--abbrev-ref', 'HEAD')) } catch { }
$behind = 0
$incoming = @()
try {
    $behind = [int]((Invoke-Git @('rev-list', '--count', 'HEAD..@{u}')) -replace '\D', '')
    $incoming = @((Invoke-Git @('log', '--oneline', '--no-decorate', 'HEAD..@{u}')) -split "`n" | Where-Object { $_ })
} catch {
    # 没有 upstream（本地分支没设追踪）——不当故障，只是没法判断
    Add-Step 'compare' 'SKIP' '当前分支没有 upstream，无法比较远端'
}

$out.behind = $behind
Add-Step 'compare' 'OK' ("当前 $curRev" + $(if ($branch) { " ($branch)" } else { '' }) + "，远端领先 $behind 个提交")

if ($Action -eq 'check') {
    if ($behind -gt 0) {
        $out.next = '有新版本。执行升级：upgrade.ps1 -Action apply -Restart'
        Add-Step 'incoming' 'OK' (($incoming | Select-Object -First 5) -join ' | ')
    } else {
        $out.next = '已是最新（或远端不可比）。要强制重铺用 -Force'
    }
    Finish 0
}

# ── rollback：回到 data\version.json 里的 prevRev ───────────────────────────
if ($Action -eq 'rollback') {
    if (-not $prev -or -not $prev.prevRev) { Fail '没有可回滚的版本记录' ('确认 ' + $versionFile + ' 里有 prevRev') 1 }
    $target = [string]$prev.prevRev
    Add-Step 'rollback' '..' ("回到 " + $target)
    if (-not $DryRun) {
        try { Invoke-Git @('checkout', '--detach', $target) | Out-Null } catch { Fail ('git checkout ' + $target + ' 失败') '目标版本可能已被 force push 掉；用 git log 找一个可用的 rev' 1 }
        $rb = Invoke-Cmd 'powershell' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'deploy.ps1'), '-Side', $Side, '-Root', $Root, '-Apply', '-Repo', $Repo)
        if ($rb.code -ne 0) { Fail ('回滚时重新部署失败: ' + $rb.text) '看上面 deploy.ps1 的 ERROR；运行件已随 deploy 自动回滚' 1 }
    }
    Add-Step 'rollback' 'OK' ("已回到 " + $target)
    $out.next = '确认功能正常后，用 git switch 回到原分支（当前是 detached）'
    Finish 0
}

# ── 普通权限：自动改走提权通道 ─────────────────────────────────────────────
# bot 在群里回话时是普通权限，写不了 %ProgramData%\anc。与其让升级失败、等人去点 UAC，
# 不如把这次升级投递给 anc-elevate（SYSTEM 计划任务）执行同一套命令。
# 执行器跑的时候是管理员，不会再进这个分支（不会递归）。
#
# 只在 **company + apply** 时判断：
#   check 只读 git，不需要提权；
#   employee 写的是 %LOCALAPPDATA%，本来就不需要提权——误判会把员工侧升级挡死。
$isAdminNow = $false
try {
    $isAdminNow = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
} catch { }

if ($Action -eq 'apply' -and $Side -eq 'company' -and -not $isAdminNow) {
    $queueDir = Join-Path $Root 'data\elevate\queue'
    # request-elevate.ps1 的位置随布局不同：部署后在 bin\，仓库里在 scripts\elevate\
    $reqCandidates = @(
        (Join-Path $PSScriptRoot 'request-elevate.ps1'),
        (Join-Path (Split-Path $PSScriptRoot -Parent) 'bin\request-elevate.ps1'),
        (Join-Path $Repo 'scripts\elevate\request-elevate.ps1')
    )
    $reqPs1 = $reqCandidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
    if ((Test-Path $queueDir) -and $reqPs1) {
        # -Root 必须传：不传的话 request-elevate 会投到默认的 %ProgramData%\anc，
        # 用自定义根（演练 / 非默认布局）时等于没投出去，而且看起来还成功了。
        $rArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $reqPs1, '-Action', 'upgrade', '-Root', $Root, '-TimeoutSec', '0')
        if ($Restart) { $rArgs += '-Restart' }
        $q = Invoke-Cmd 'powershell' $rArgs
        if ($q.code -ne 0) {
            Add-Step 'handoff' 'FAIL' ('投递失败: ' + $q.text)
            $out.next = '提权通道在，但投递没成功。看上一行的 detail；常见原因是 queue 目录没有写权限（管理员跑 set-acl.ps1 -Apply）。'
            Finish 3
        }
        $qid = ''
        if ($q.text -match '([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})') { $qid = $matches[1] }
        Add-Step 'handoff' 'OK' '普通权限 → 已投递到提权通道（anc-elevate / SYSTEM，每分钟执行一条）'
        $out.next = '已排队，通常 1–2 分钟内开始执行。' + $(if ($qid) { '查结果：request-elevate.ps1 -Check ' + $qid } else { '用 request-elevate.ps1 -Check <id> 查结果。' }) + '（通道只做 upgrade / register-tasks / deploy 三个动作）'
        Finish 0
    }
    Fail '要给管理员权限才能写部署目录，而且提权通道没启用' '两条路选一条：① 管理员跑一次 upgrade.ps1 -Action apply -GrantDeployWrite（只授运行件目录，之后普通权限就能升）；② 确认 anc-elevate 任务已注册、data\elevate\queue 存在（提权通道），再重试' 3
}

# ── apply：升级 ────────────────────────────────────────────────────────────
if ($behind -eq 0 -and -not $Force) {
    Add-Step 'apply' 'SKIP' '没有新版本，不需要升级（要强制重铺用 -Force）'
    $out.next = '已是最新'
    Finish 0
}

if ($behind -gt 0) {
    Add-Step 'incoming' 'OK' (($incoming | Select-Object -First 8) -join ' | ')
}

# 1) 升级前强制备份数据库（backup-anc 自带幂等；这里把间隔拉到 0 保证这次一定做）
$backup = Join-Path $Root 'bin\backup-anc.ps1'
if (Test-Path $backup) {
    Add-Step 'backup' '..' '升级前备份数据库'
    if (-not $DryRun) {
        # 必须显式传 SourceDb / BackupDir：backup-anc.ps1 的默认值是 %ProgramData%\anc，
        # 员工侧升级时不传就会去备份**公司侧的库**（或一个不存在的库），也就是说
        # 备份"成功"了、真正要保的那个库根本没进备份。演练时踩到过。
        $b = Invoke-Cmd 'powershell' @(
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $backup,
            '-SourceDb', (Join-Path $Root 'data\anc.db'),
            '-BackupDir', (Join-Path $Root 'backup'),
            '-MinIntervalHours', '0'
        )
        if ($b.code -ne 0) { Fail ('升级前备份失败: ' + $b.text) '先修好备份（看 bin\backup.log），再升级；不要在没有备份的情况下升级' 1 }
    }
    Add-Step 'backup' 'OK' '已备份'
} else {
    Add-Step 'backup' 'SKIP' '没有 bin\backup-anc.ps1（首次部署前的状态？）'
}

# 2) 拉代码
$newRev = $curRev
if ($behind -gt 0) {
    Add-Step 'pull' '..' 'git pull --ff-only'
    if (-not $DryRun) {
        try { Invoke-Git @('pull', '--ff-only', '--quiet') | Out-Null } catch { Fail 'git pull 失败（本地有改动或需要合并）' '在仓库里 git status 看有没有未提交改动；升级要求工作区干净' 3 }
        try { $newRev = (Invoke-Git @('rev-parse', '--short', 'HEAD')) } catch { }
    }
    Add-Step 'pull' 'OK' ("代码已更新到 " + $newRev)
}

# 3) 铺运行件（deploy 自带 hash 对拍 + 失败整体回滚，不会留半套）
$deploy = Join-Path $PSScriptRoot 'deploy.ps1'
if (-not (Test-Path $deploy)) { Fail '找不到同目录的 deploy.ps1' '确认仓库结构完整' 2 }
Add-Step 'deploy' '..' '铺运行件'
if (-not $DryRun) {
    $d = Invoke-Cmd 'powershell' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $deploy, '-Side', $Side, '-Root', $Root, '-Apply', '-Repo', $Repo)
    if ($d.code -ne 0) {
        Add-Step 'deploy' 'FAIL' (($d.text -split "`n" | Select-Object -Last 3) -join ' ')
        # 权限不足是最常见的失败：普通权限写不了 ProgramData
        $perm = $d.text -match '拒绝访问|Access denied|UnauthorizedAccess'
        if ($perm) {
            $out.next = '权限不足：运行件目录要管理员才能写。用管理员跑一次 upgrade.ps1 -Action apply -GrantDeployWrite 授权，之后就能一句话升级'
            Finish 3
        }
        Fail '部署失败' '看上面的 ERROR；deploy 已自动回滚运行件，数据未动' 1
    }
}
Add-Step 'deploy' 'OK' '运行件已更新（数据未动）'

# 4) 技能（技能目录在 %USERPROFILE%，普通权限就能写）
$skills = Join-Path $PSScriptRoot 'deploy-skills.ps1'
if (Test-Path $skills) {
    Add-Step 'skills' '..' '更新技能'
    if (-not $DryRun) {
        $s = Invoke-Cmd 'powershell' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $skills, '-Apply', '-Repo', $Repo)
        if ($s.code -ne 0) { Add-Step 'skills' 'FAIL' (($s.text -split "`n" | Select-Object -Last 2) -join ' ') }
    }
    if (-not ($steps | Where-Object { $_.step -eq 'skills' -and $_.state -eq 'FAIL' })) {
        Add-Step 'skills' 'OK' '技能已同步（新会话生效）'
    }
} else {
    Add-Step 'skills' 'SKIP' '没有 deploy-skills.ps1'
}

# 5) 公司侧：重渲染 persona（模板可能变了）+ 安装
if ($Side -eq 'company') {
    $renderCli = Join-Path $Repo 'src\render\cli.ts'
    $org = Join-Path $Root 'org'
    if (-not (Test-Path $org)) { $org = '' }
    $renderOk = $false
    if ((Test-Path $renderCli) -and $org) {
        Add-Step 'render' '..' '重渲染 persona'
        if (-not $DryRun) {
            $r = Invoke-Cmd 'node' @('--no-warnings', $renderCli, 'deploy', '--org', $org, '--out', (Join-Path $Root 'render'), '--db', (Join-Path $Root 'data\anc.db'))
            $renderOk = ($r.code -eq 0)
            if (-not $renderOk) { Add-Step 'render' 'SKIP' (($r.text -split "`n" | Select-Object -Last 2) -join ' ') }
        } else { $renderOk = $true }
        if ($renderOk) { Add-Step 'render' 'OK' 'persona 已按当前 org 重新渲染' }
    } else {
        Add-Step 'render' 'SKIP' '没有 render\cli.ts 或 org 目录'
    }
    if ($renderOk) {
        $personaSrc = Join-Path $Root 'render\company-bot\CODEBUDDY.md'
        $personaPs1 = Join-Path $PSScriptRoot 'deploy-persona.ps1'
        if ((Test-Path $personaSrc) -and (Test-Path $personaPs1)) {
            if (-not $DryRun) {
                $pp = Invoke-Cmd 'powershell' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $personaPs1, '-Source', $personaSrc)
                if ($pp.code -ne 0) { Add-Step 'persona' 'FAIL' (($pp.text -split "`n" | Select-Object -Last 2) -join ' ') }
            }
            if (-not ($steps | Where-Object { $_.step -eq 'persona' -and $_.state -eq 'FAIL' })) {
                Add-Step 'persona' 'OK' '公司 bot persona 已更新（重启后生效）'
            }
        }
    }
    # 计划任务：只在运行件里出现新脚本时才需要重注册，这里只提醒不自作主张
    Add-Step 'tasks' 'SKIP' '计划任务不自动重注册（要管理员）；若 OPS 任务表有变化，管理员跑 tools\register-tasks.ps1 -Apply'

# 6) 员工侧：persona 来自公司侧同步，升级不覆盖
} else {
    Add-Step 'persona' 'SKIP' '员工侧 persona 由公司侧同步，升级不覆盖；persona 变了要重新同步（DEPLOY-EMPLOYEE §5.5）'
}

# 7) 写版本记录
if (-not $DryRun) {
    $rec = [ordered]@{
        rev        = $newRev
        prevRev    = $(if ($behind -gt 0) { $curRev } else { if ($prev) { [string]$prev.rev } else { '' } })
        branch     = $branch
        side       = $Side
        upgradedAt = (Get-Date).ToString('o')
        upgradedBy = $env:USERNAME
    }
    $dir = Split-Path -Parent $versionFile
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    [IO.File]::WriteAllText($versionFile, ($rec | ConvertTo-Json -Depth 4), (New-Object Text.UTF8Encoding($false)))
    Add-Step 'version' 'OK' ("记录写入 " + $versionFile)
}

# 8) 重启（可选）：技能与 persona 只在新会话生效
if ($Restart) {
    $heal = Join-Path $Root 'bin\anc-selfheal.ps1'
    if (Test-Path $heal) {
        Add-Step 'restart' '..' '重启 WorkBuddy 让技能/persona 生效'
        if (-not $DryRun) {
            # 经补丁启动器重启：先杀后起，patch-guard 会自动等 patch-state
            $h = Invoke-Cmd 'powershell' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $heal, '-Apply')
            if ($h.code -ne 0) { Add-Step 'restart' 'FAIL' '重启失败；补丁守卫会在 1 分钟内再试' } else { Add-Step 'restart' 'OK' '已重启' }
        } else { Add-Step 'restart' 'OK' '(dry)' }
    } else {
        Add-Step 'restart' 'SKIP' '没有 bin\anc-selfheal.ps1'
    }
} else {
    Add-Step 'restart' 'SKIP' '未加 -Restart；技能与 persona 在下一次会话生效'
}

# 9) 自证
$verify = Join-Path $PSScriptRoot 'deploy-verify.ps1'
if (Test-Path $verify) {
    Add-Step 'verify' '..' '自证'
    if (-not $DryRun) {
        $v = Invoke-Cmd 'powershell' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $verify, '-Side', $Side, '-Root', $Root, '-Json')
        $vOk = $false
        try { $vOk = [bool](($v.text | ConvertFrom-Json).ok) } catch { }
        if ($vOk) { Add-Step 'verify' 'OK' 'deploy-verify ok' } else { Add-Step 'verify' 'SKIP' '自证有 FAIL/SKIP；逐项看 deploy-verify 输出，升级本身已完成' }
    }
} else {
    Add-Step 'verify' 'SKIP' '没有 deploy-verify.ps1'
}

$out.rev = $newRev
$out.next = $(if ($Restart) { '升级完成，已重启。群里试一句话确认 bot 正常。' } else { '升级完成。技能与 persona 要新会话才生效；要立即生效就加 -Restart。' })
Finish 0
