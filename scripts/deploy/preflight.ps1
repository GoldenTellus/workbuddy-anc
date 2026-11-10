# 部署前置检查 —— 给"要装这套系统"的 agent 用，不是给人看的体检。
#
# 和 doctor.ps1 的区别：
#   doctor   ：装好之后查"这套系统现在还健康吗"，30 项，慢（~18s）
#   preflight：装之前查"这台机器能不能装"，快，输出直接告诉 agent 下一步做什么
#
# 输出（-Json 时）：
#   {
#     ok: bool,                 所有 blocker 都没有才 true
#     side: "company"|"employee",
#     blockers: [{ check, detail, fix }],   有这些就别装了，先修
#     warnings: [{ check, detail, fix }],   能装，但要知道
#     next: "继续 / 先修 X / 停下来问用户 Y"
#     facts: {...}               agent 判断要用到的原始值
#   }
#
# 退出码：0 = 可以装 / 1 = 有 blocker（别装）/ 2 = 用法错误
#
# 用法：
#   powershell -File scripts\deploy\preflight.ps1 -Side company -Json
#   powershell -File scripts\deploy\preflight.ps1 -Side employee -Root D:\anc -Json
#   powershell -File scripts\deploy\preflight.ps1 -Side company -Root Z:\anc-root -Json   # 演练

param(
    [ValidateSet('company', 'employee')]
    [string]$Side = 'company',

    # 部署根（对应 %ProgramData%\anc）。演练时指向别的盘，用来验"路径假设"
    [string]$Root = '',

    # vault 根（对应 D:\anc）。不传就按 D:\anc 判
    [string]$VaultRoot = '',

    [switch]$Json
)

# 为什么是 SilentlyContinue 而不是 Continue：
#   这个脚本的输出只有两种——JSON 或人读的文本。任何非终止错误打到 stderr，
#   调用方（agent）一旦用 `2>&1` 就会污染 JSON。所有判断都由下面的 Block/Warn 显式做，
#   不靠错误流兜。
$ErrorActionPreference = 'SilentlyContinue'

# Root 默认值按侧分：
#   company  —— %ProgramData%\anc（要注册计划任务、写 ProgramData，所以必须管理员）
#   employee —— %LOCALAPPDATA%\anc（个人电脑上不该碰 ProgramData）
# 2026-11-05 修：原来两侧都用 ProgramData，employee 侧会误报 already-installed。
if (-not $Root) {
    $Root = if ($Side -eq 'company') { Join-Path $env:ProgramData 'anc' } else { Join-Path $env:LOCALAPPDATA 'anc' }
}
if (-not $VaultRoot) { $VaultRoot = 'D:\anc' }

$blockers = @()
$warnings = @()
$facts = [ordered]@{}

function Block([string]$check, [string]$detail, [string]$fix) {
    $script:blockers += [pscustomobject]@{ check = $check; detail = $detail; fix = $fix }
}
function Warn([string]$check, [string]$detail, [string]$fix) {
    $script:warnings += [pscustomobject]@{ check = $check; detail = $detail; fix = $fix }
}

# ── 1 OS 版本 ───────────────────────────────────────────────
# 为什么查：补丁链依赖 Electron 的 preload 劫持；Windows 10 1809 以下没有
# 现在这套依赖的 PowerShell 5.1 和 .NET 类。19045（22H2）是实测过的版本。
try {
    $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
    $build = [int]$os.BuildNumber
    $facts['os'] = $os.Caption + ' build ' + $build
    if ($build -lt 17763) {
        Block 'os' "Windows build $build 太旧（要 17763 / 1809 以上）" '换一台 Windows 10 1809+ 或 Windows 11'
    } elseif ($build -lt 19041) {
        Warn 'os' "build $build 没在这套的实测范围（19045 验过）" '可以装，但出问题先怀疑这里'
    }
} catch {
    Block 'os' '读不到 OS 版本' '确认这台是 Windows，且能跑 Get-CimInstance'
}

# ── 2 PowerShell 版本 ───────────────────────────────────────
# 5.1 是唯一验过的版本。7.x 有语法差异（这个仓库的脚本按 5.1 写）
$psv = $PSVersionTable.PSVersion
$facts['powershell'] = $psv.ToString()
if ($psv.Major -lt 5) {
    Block 'powershell' "PowerShell $psv 太旧" '用 Windows 自带的 5.1 或更高'
} elseif ($psv.Major -gt 5) {
    Warn 'powershell' "PowerShell $psv —— 这套脚本只在 5.1 上验过" '用 powershell.exe（5.1）而不是 pwsh.exe 跑'
}

# ── 3 运行身份与机器画像 ────────────────────────────────────
# 为什么不是简单的「是不是管理员」：
#   这个项目要装到很多台机器上，每台的条件不一样。同样是 isAdmin=false，
#   可能是「员工在自己账号里装员工侧」（完全正常），也可能是「公司主机用普通权限开了 agent」（必须拦住）。
#   所以这里输出一个**画像**，再按画像给结论与人话指导，而不是只报 true/false。
#
# 关键语义：agent 跑在 WorkBuddy 里，它执行的命令**继承 WorkBuddy 的 token**。
# 所以 `isAdmin=false` 就等于「WorkBuddy 不是以管理员身份打开的」。
$isAdmin = $false
try {
    $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
} catch { }
$facts['isAdmin'] = $isAdmin
$facts['user'] = $env:USERNAME

# 账号本身在不在管理员组（和当前 token 提没提权是两件事：不在组里，UAC 也提不上去）
$inAdminGroup = $false
try {
    $inAdminGroup = [bool](@([Security.Principal.WindowsIdentity]::GetCurrent().Groups |
        Where-Object { $_.Value -eq 'S-1-5-32-544' }).Count)
} catch { }
$facts['inAdminGroup'] = $inAdminGroup

# 是不是内置 Administrator（SID 尾号 500）——它和「某个在管理员组的普通账号」不是一回事
$isBuiltinAdmin = $false
try { $isBuiltinAdmin = (([Security.Principal.WindowsIdentity]::GetCurrent().User.Value) -match '-500$') } catch { }
$facts['isBuiltinAdmin'] = $isBuiltinAdmin

# UAC：EnableLUA=0 表示整机没有拦截层（内置 Administrator 登录时默认如此）
$uacEnabled = $null
$filterAdminToken = $null
try {
    $pol = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' -ErrorAction Stop
    if ($null -ne $pol.EnableLUA) { $uacEnabled = ([int]$pol.EnableLUA -eq 1) }
    if ($null -ne $pol.FilterAdministratorToken) { $filterAdminToken = ([int]$pol.FilterAdministratorToken -eq 1) }
} catch { }
$facts['uacEnabled'] = $uacEnabled
$facts['filterAdminToken'] = $filterAdminToken

# 本机有几个用户配置目录（粗略判断是不是多人共用一台机器）
try {
    $usersDir = Join-Path $env:SystemDrive 'Users'
    $facts['userProfiles'] = @(Get-ChildItem $usersDir -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -notin @('Public', 'Default', 'Default User', 'All Users') }).Count
} catch { $facts['userProfiles'] = $null }

# 画像判定（顺序有讲究：先判最危险的组合）
$machineProfile = 'standard-user'
if ($isBuiltinAdmin -and $uacEnabled -eq $false) { $machineProfile = 'builtin-admin-uac-off' }
elseif ($isBuiltinAdmin) { $machineProfile = 'builtin-admin' }
elseif ($isAdmin -and $inAdminGroup) { $machineProfile = 'admin-elevated' }
elseif ($inAdminGroup) { $machineProfile = 'admin-not-elevated' }
$facts['machineProfile'] = $machineProfile

# 按画像给人话指导。这些会原样进 JSON，agent 直接照着说，不用自己推断。
$guidance = @()
switch ($machineProfile) {
    'builtin-admin-uac-off' {
        $guidance += '这台机器用内置 Administrator 登录，且 UAC 已关闭：整机没有拦截层，bot 长期以最高权限运行——群里任何人一句话都可能在 root 下执行。'
        $guidance += '建议改成「在管理员组里的普通账号 + 打开 UAC」再部署；已经装好的，换账号要重做部署（persona 和技能绑在账号的 profile 上）。'
    }
    'builtin-admin' {
        $guidance += '这台机器用内置 Administrator 登录（UAC 开着）：能用，但这个账号是共享身份，多台机器都这样会无法归因。'
        $guidance += '更推荐用「在管理员组里的普通账号」登录：需要提权时 UAC 弹一次，日常进程不是提权的。'
    }
    'admin-elevated' {
        $guidance += 'agent 以管理员身份运行，账号也在管理员组：公司侧安装条件满足，可以按手册连续做下去。'
    }
    'admin-not-elevated' {
        $guidance += '这个账号在管理员组，但 agent 当前是普通权限。公司侧装不了（写不了 ProgramData、注册不了计划任务），需要重开。'
        $guidance += '做法：关掉 WorkBuddy → 右键图标 →「以管理员身份运行」→ 重开会话再跑 preflight。'
    }
    'standard-user' {
        $guidance += '当前是标准用户（不在管理员组）。员工侧可以装；公司侧不行，需要换有管理员权限的账号。'
    }
}

if ($Side -eq 'company' -and -not $isAdmin) {
    if (-not $inAdminGroup) {
        # 不在管理员组时，让用户去点 UAC 是白费劲：根本提不上去
        Block 'agent-elevated' "agent 是普通权限，且账号 $env:USERNAME 不在管理员组" '换一个在管理员组的账号登录这台机器，再用「以管理员身份运行」打开 WorkBuddy；或者让管理员用他的账号装。当前账号即使 UAC 也提不上去。'
    } else {
        Block 'agent-elevated' "agent 不是以管理员身份打开的（$env:USERNAME 在管理员组，但当前是普通权限）" '关掉 WorkBuddy → 右键 WorkBuddy 图标 →「以管理员身份运行」→ 重新打开本会话再跑 preflight。部署要写 %ProgramData%\anc、注册计划任务、设 ACL，普通权限做不到。UAC 弹框点「是」，**不要输入另一个管理员账号的密码**——那会把 %USERPROFILE% 换成别人的，persona 和技能全读不到。'
    }
}
if ($Side -eq 'employee' -and -not $isAdmin) {
    Warn 'agent-elevated' 'agent 是普通权限（员工侧不需要提权，可以继续）' '员工侧只写你自己的 %LOCALAPPDATA%\anc 和 %USERPROFILE%\.workbuddy\skills，不需要管理员。想省事用管理员打开也行，profile 不会变。'
}
if ($Side -eq 'employee' -and $facts['userProfiles'] -ge 3) {
    Warn 'shared-machine' ("这台机器有 " + $facts['userProfiles'] + ' 个用户配置目录，确认不是多人共用的电脑') '个人 bot 用登录身份工作；共用电脑上装，等于让别人也能用你的身份。确认是本人专用再继续。'
}
$facts['guidance'] = $guidance

# ── 4 node / git ────────────────────────────────────────────
# node：服务本身就是 node 跑的；git：补丁和部署都从仓库读
foreach ($tool in @('node', 'git')) {
    $cmd = Get-Command $tool -ErrorAction SilentlyContinue
    if (-not $cmd) {
        Block $tool "找不到 $tool" $(if ($tool -eq 'node') { '装 Node 22 LTS 以上（https://nodejs.org），装完重开 PowerShell' } else { '装 Git for Windows（https://git-scm.com），装完重开 PowerShell' })
    } else {
        $ver = ''
        try { $ver = (& $tool --version 2>&1 | Out-String).Trim() } catch { }
        $facts[$tool] = $ver
        if ($tool -eq 'node' -and $ver -match 'v(\d+)') {
            $major = [int]$matches[1]
            if ($major -lt 22) { Block 'node-version' "Node $ver 太旧（要 22+）" '升级到 Node 22 LTS 以上' }
        }
    }
}

# ── 5 部署根与磁盘 ──────────────────────────────────────────
$facts['root'] = $Root
$facts['vaultRoot'] = $VaultRoot
try {
    $rootDrive = (Split-Path -Qualifier $Root)
    if (-not $rootDrive) { throw "Root 没有盘符: $Root" }
    $d = Get-PSDrive -Name $rootDrive.TrimEnd(':') -ErrorAction Stop
    $freeMB = [math]::Round($d.Free / 1MB)
    $facts['rootFreeMB'] = $freeMB
    if ($freeMB -lt 200) {
        Block 'disk' "$rootDrive 只剩 ${freeMB}MB（要 200MB 以上）" '清出空间，或换一个盘做部署根'
    }
} catch {
    Block 'disk' "读不到 $Root 所在盘（$rootDrive 不存在？）" '确认这个盘符存在，或用 -Root 指定别的盘'
}

# vault 根（D 盘）：company 侧要写 vault，employee 侧只读共享区
if ($Side -eq 'company') {
    $vaultDrive = ''; try { $vaultDrive = (Split-Path -Qualifier $VaultRoot) } catch { }
    if (-not $vaultDrive) {
        Block 'vault-drive' "VaultRoot 没有盘符: $VaultRoot" '用 -VaultRoot 指定一个绝对路径（比如 D:\anc 或 C:\anc-vault）'
    } elseif (-not (Test-Path "$vaultDrive\")) {
        # 2026-11-05 从 WARN 改成 BLOCKER：vault 盘不存在，装完什么都写不进去，
        # 这时候"能装"是假的——装完第一次入库就炸。
        Block 'vault-drive' "$vaultDrive 不存在（vault 根指向 $VaultRoot）" "要么建这个盘，要么用 -VaultRoot 指到已有盘（比如 $env:SystemDrive\anc-vault）"
    } else {
        try {
            $vd = Get-PSDrive -Name $vaultDrive.TrimEnd(':') -ErrorAction Stop
            $vFree = [math]::Round($vd.Free / 1MB)
            $facts['vaultFreeMB'] = $vFree
            if ($vFree -lt 500) { Warn 'vault-disk' "$vaultDrive 只剩 ${vFree}MB" 'vault 会长，留 500MB 以上再说' }
        } catch { }
    }
}

# ── 6 已经装过了吗 ──────────────────────────────────────────
# 这是最容易出事的一项：在已装的机器上重跑部署，会覆盖线上 persona 和配置。
# 所以不 block，但要 agent 明确知道"这是重装/升级，不是首装"。
# Root 所在盘可能根本不存在（用户把 -Root 指到 Q:\nope），Join-Path 会直接抛——
# 那会让整个 preflight 崩掉、输出不是 JSON，agent 就没法判断了。
$dbPath = ''
try { $dbPath = Join-Path $Root 'data\anc.db' -ErrorAction SilentlyContinue } catch { }
$already = if ($dbPath) { Test-Path $dbPath -ErrorAction SilentlyContinue } else { $false }
$facts['alreadyInstalled'] = $already
if ($already) {
    $sizeKB = [math]::Round((Get-Item $dbPath -ErrorAction SilentlyContinue).Length / 1KB)
    Warn 'already-installed' "这个根下已经有库了（$dbPath, ${sizeKB}KB）" '如果要重装：先备份，然后确认是要"升级"还是"重建"。要重建请显式加 -Force（见 docs/DEPLOY-COMPANY.md §14 重装与卸载）'
}

# ── 7 端口 ──────────────────────────────────────────────────
# 17999 是 test-emit（调试用，默认关）；HTTP 面端口从配置读，读不到按默认
$portChecks = @(
    @{ port = 17999; name = 'test-emit' }
)
foreach ($pc in $portChecks) {
    $used = $false
    try { $used = [bool](Get-NetTCPConnection -LocalPort $pc.port -State Listen -ErrorAction SilentlyContinue) } catch { }
    $facts['port' + $pc.port] = $used
    if ($used) {
        # 这个端口被占用不算 blocker：如果占用者就是这套系统自己，重装时是正常的
        Warn ('port-' + $pc.port) "$($pc.port) ($($pc.name)) 已被占用" '如果是旧的 WorkBuddy 实例在跑，先关掉它；如果是这套系统自己的 test-emit，忽略这条'
    }
}

# ── 8 计划任务是否已注册（只影响 company）────────────────────
if ($Side -eq 'company') {
    $tasks = @(Get-ScheduledTask -TaskName 'anc-*' -ErrorAction SilentlyContinue)
    $facts['existingTasks'] = $tasks.Count
    if ($tasks.Count -gt 0) {
        # 非提权会话看不到 LOCAL SERVICE / SYSTEM 的任务，只会看到交互类那 3 个。
        # 2026-11-10 修：原来直接说「已经有 3 个」—— GAP-081 就是照这句话判断「只注册了 3 个」，
        # 实际是提权问题，13 个都在。文案必须把「看不到」和「没有」分开。
        if (-not $facts['isAdmin'] -and $tasks.Count -lt 11) {
            Warn 'tasks' "非提权会话只看到 $($tasks.Count) 个 anc-* 任务（服务类任务要管理员会话才可见，不代表没注册）" '别据此判断数量：用管理员 PowerShell 跑 Get-ScheduledTask -TaskName anc-*；要补齐就 register-tasks.ps1 -Apply'
        } else {
            Warn 'tasks' "已经有 $($tasks.Count) 个 anc-* 计划任务" '重装会覆盖它们；要保留就先把任务导出'
        }
    }
}

# ── 9 WorkBuddy 装了吗 ──────────────────────────────────────
# company 侧的第 0 步是"装一个空 WorkBuddy"；employee 侧本来就该有
$wbCandidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\WorkBuddy\WorkBuddy.exe' -ErrorAction SilentlyContinue),
    (Join-Path $env:ProgramFiles 'WorkBuddy\WorkBuddy.exe' -ErrorAction SilentlyContinue)
)
$wbPath = $wbCandidates | Where-Object { Test-Path $_ -ErrorAction SilentlyContinue } | Select-Object -First 1
$hasWb = [bool]$wbPath
$facts['workbuddy'] = if ($hasWb) { $wbPath } else { $null }
if ($Side -eq 'company' -and -not $hasWb) {
    Block 'workbuddy' '没装 WorkBuddy' '这是第 0 步（只有人能做）：装一个空 WorkBuddy，装完不要配任何东西，回来重跑这个检查'
}
if ($Side -eq 'employee' -and -not $hasWb) {
    Block 'workbuddy' '没装 WorkBuddy' '先在你这台电脑装 WorkBuddy 并登录，然后重跑这个检查'
}

# ── 10 部署根是否等于启动器里写死的路径（只影响 company）──────
# scripts\launch\anc-loop.cmd 和 anc-http.cmd 把 C:\ProgramData\anc 写死了（启动器要幂等、不带变量）。
# -Root 指到别处时，任务照样注册成功、照样去调 .cmd，而 .cmd 仍从 C:\ProgramData\anc 找 cli.ts 和库 ——
# 症状是「部署说成功、服务却在跑另一个库」，极难查。演练用自定义根可以，生产必须用默认根。
if ($Side -eq 'company') {
    $defaultRoot = Join-Path $env:ProgramData 'anc'
    try { $sameRoot = ([IO.Path]::GetFullPath($Root).TrimEnd('\') -ieq [IO.Path]::GetFullPath($defaultRoot).TrimEnd('\')) }
    catch { $sameRoot = $false }
    $facts['defaultRoot'] = $sameRoot
    if (-not $sameRoot) {
        Warn 'root-not-default' "部署根 $Root 不是默认的 $defaultRoot，而 bin\anc-loop.cmd / anc-http.cmd 里写死了默认路径" '演练可以忽略；生产必须用默认根，或先改 scripts\launch\*.cmd 再部署，否则计划任务会指着另一个库跑'
    }
}

# ── 输出 ────────────────────────────────────────────────────
$ok = ($blockers.Count -eq 0)

# next：告诉 agent 下一步做什么。这是整个脚本最重要的输出。
$next = ''
if (-not $ok) {
    $next = '先修 blocker，再重跑本检查。清单里的 fix 就是做法。'
    # 如果 blocker 全是"要人给东西"，说清楚要停下来问
    $needsHuman = @($blockers | Where-Object { $_.check -in @('workbuddy', 'agent-elevated') })
    if ($needsHuman.Count -eq $blockers.Count) {
        $next = '停下来问用户：' + (($blockers | ForEach-Object { $_.check }) -join ' / ') + ' 这几项只有人能处理。'
    }
} elseif ($warnings.Count -gt 0) {
    $next = '可以继续。先看 warnings 里有没有需要用户确认的（尤其是 already-installed）。'
} else {
    $next = '可以继续。'
}

if ($Json) {
    [pscustomobject]@{
        ok       = $ok
        side     = $Side
        blockers = $blockers
        warnings = $warnings
        next     = $next
        facts    = $facts
    } | ConvertTo-Json -Depth 5
} else {
    Write-Host ("=== preflight ({0}) ===" -f $Side)
    Write-Host ("根: {0}   vault: {1}" -f $Root, $VaultRoot)
    Write-Host ''
    if ($blockers.Count -eq 0) { Write-Host 'BLOCKER  无' }
    foreach ($b in $blockers) {
        Write-Host ("BLOCKER  {0}  {1}" -f $b.check, $b.detail)
        Write-Host ("         FIX  {0}" -f $b.fix)
    }
    foreach ($w in $warnings) {
        Write-Host ("WARN     {0}  {1}" -f $w.check, $w.detail)
        Write-Host ("         FIX  {0}" -f $w.fix)
    }
    Write-Host ''
    Write-Host ("NEXT  {0}" -f $next)
    Write-Host ''
    Write-Host 'FACTS'
    foreach ($k in $facts.Keys) {
        # guidance 是数组，直接打会变成 System.Object[]；下面单独整段打印
        if ($k -eq 'guidance') { continue }
        Write-Host ("  {0,-18} {1}" -f $k, $facts[$k])
    }
    if ($facts['guidance'] -and @($facts['guidance']).Count -gt 0) {
        Write-Host ''
        Write-Host 'GUIDANCE（按这台机器的画像给出的做法）'
        foreach ($g in @($facts['guidance'])) { Write-Host ('  - ' + $g) }
    }
}

exit $(if ($ok) { 0 } else { 1 })
