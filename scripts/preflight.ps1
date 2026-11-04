# 部署前置检查 —— 给"要装这套系统"的 agent 用，不是给人看的体检。
#
# 和 doctor.ps1 的区别：
#   doctor   ：装好之后查"这套系统现在还健康吗"，29 项，慢（~18s）
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
#   powershell -File scripts\preflight.ps1 -Side company -Json
#   powershell -File scripts\preflight.ps1 -Side employee -Root D:\anc -Json
#   powershell -File scripts\preflight.ps1 -Side company -Root Z:\anc-root -Json   # 演练

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

# ── 3 管理员权限 ────────────────────────────────────────────
# 公司侧必须：要注册计划任务、写 ProgramData、改 ACL、杀进程
# 员工侧不必须：只写用户目录
$isAdmin = $false
try {
    $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
} catch { }
$facts['isAdmin'] = $isAdmin
$facts['user'] = $env:USERNAME
if ($Side -eq 'company' -and -not $isAdmin) {
    Block 'admin' "公司侧要以管理员跑（当前是 $env:USERNAME）" '右键"以管理员身份运行"重开 PowerShell，或换管理员账号'
}

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
    Warn 'already-installed' "这个根下已经有库了（$dbPath, ${sizeKB}KB）" '如果要重装：先备份，然后确认是要"升级"还是"重建"。要重建请显式加 -Force（见 AGENT-DEPLOY 的回滚节）'
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
        Warn 'tasks' "已经有 $($tasks.Count) 个 anc-* 计划任务" '重装会覆盖它们；要保留就先把任务导出'
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

# ── 输出 ────────────────────────────────────────────────────
$ok = ($blockers.Count -eq 0)

# next：告诉 agent 下一步做什么。这是整个脚本最重要的输出。
$next = ''
if (-not $ok) {
    $next = '先修 blocker，再重跑本检查。清单里的 fix 就是做法。'
    # 如果 blocker 全是"要人给东西"，说清楚要停下来问
    $needsHuman = @($blockers | Where-Object { $_.check -in @('workbuddy', 'admin') })
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
    foreach ($k in $facts.Keys) { Write-Host ("  {0,-18} {1}" -f $k, $facts[$k]) }
}

exit $(if ($ok) { 0 } else { 1 })
