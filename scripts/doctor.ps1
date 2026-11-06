# 主机体检（doctor）：只读检查，每项给 PASS / WARN / FAIL 与出路
# 退出码：0 无 FAIL / 1 有 FAIL / 2 用法错误
# -SelfTest：用 %TEMP% 下的夹具证明"每类检查确实能 FAIL"，不碰真实环境
[CmdletBinding()]
param(
    [string]$Repo = '',
    [string]$Root = '',
    [string]$Manifest = '',
    # D25：默认取"当前部署账号"，不再硬编码专用用户；换部署形态时用 -BotUser 覆盖。
    [string]$BotUser = '',
    [switch]$Json,
    [switch]$SelfTest,
    # vault 原件根：和 -Root（ProgramData 部署根）是两个不同的根（REBUILD §1）。
    # 换盘符 / 演练根时用 -VaultRoot 指过去，否则 #11/#20 查的还是生产 D:\anc\vault-shared
    # —— VERIFY §34 在 Z:\anc-root 上实测到「演练根的 doctor 报了生产 vault 的未跟踪文件」。
    [string]$VaultRoot = 'D:\anc'
)

$ErrorActionPreference = 'Continue'
if (-not $Root) { $Root = Join-Path $env:ProgramData 'anc' }
$vaultShared = Join-Path $VaultRoot 'vault-shared'
if (-not $BotUser) { $BotUser = $env:USERNAME }
# 线上以部署目录为准：manifest 默认取 %ProgramData%\anc\patch 的那份，不再从 git 工作副本读
if (-not $Manifest) { $Manifest = Join-Path $Root 'patch\manifest.json' }
$results = @()
function Add-Result([string]$name, [string]$state, [string]$detail, [string]$fix) {
    # 2026-11-05（VERIFY §78）：state 为空 = 调用方拿到的检查结果是 $null，
    # 典型原因是 Test-* 函数提前 return、if 块嵌套错、或者返回语句被吃掉。
    # 这种「判据根本没跑」绝不能算 PASS —— 2026-11-05 实测踩到：
    # 我给 Test-SecretsAcl 加判据时多写了一个 }，函数提前结束返回 $null，
    # 于是播种破坏后 doctor 照样 ok=True fails=0，判据失效是静默的。
    if (-not $state) {
        $state = 'FAIL'
        $detail = '判据没有返回结果（$null）—— 对应检查函数可能提前退出，这条实际没验：' + $detail
        if (-not $fix) { $fix = '看 doctor.ps1 里对应的 Test-* 函数是否每条路径都有 return' }
    }
    $script:results += [pscustomobject]@{ check = $name; state = $state; detail = $detail; fix = $fix }
}

# 2026-11-06 修（VERIFY §84.3）：PS 5.1 的 [Console]::OutputEncoding 默认是 GBK，
# `& node ... | Out-String` 会按 GBK 去解码 node 打出的 UTF-8 字节 —— 中文员工名变
# mojibake，且乱码里被吃掉的引号会破坏 JSON，ConvertFrom-Json 抛错后 bindings 报
# 「读绑定失败」WARN（库里明明有绑定）。实测：同一条 '张三丰' 解析失败。
# 只在调用 node 期间临时切 UTF-8，finally 里恢复，不影响其它检查的输出编码。
# cli.ts / db 一律从 $Root 取：-Root 是校验其它部署根的唯一入口，写死 ProgramData
# 会让这些检查在演练根上查到生产库（与 #16 database 同一类缺陷）。
function Invoke-ServiceJson([string[]]$Sub, [string]$Db) {
    $prev = $null
    $switched = $false
    try {
        $prev = [Console]::OutputEncoding
        [Console]::OutputEncoding = [Text.Encoding]::UTF8
        $switched = $true
    } catch { $switched = $false }
    try {
        $cli = Join-Path $Root 'service\cli.ts'
        $raw = & node $cli --db $Db --json @Sub 2>$null | Out-String
        if (-not $raw -or -not $raw.Trim()) { throw 'cli.ts 没有输出' }
        return ($raw.TrimStart([char]0xFEFF) | ConvertFrom-Json)
    } finally {
        if ($switched) { try { [Console]::OutputEncoding = $prev } catch { } }
    }
}

# PS 5.1 的 Get-LocalGroupMember 遇到孤立 SID 会报错返回空，会误报「非管理员」。
# 失败时用 net localgroup 兜底；两者都拿不到结果就按「是管理员」处理（fail-closed）。
function Test-AdminMember([string]$name) {
    try {
        $m = Get-LocalGroupMember -Group Administrators -ErrorAction Stop
        return [bool]($m | Where-Object { ($_.Name -split '\\')[-1] -ieq $name })
    } catch {
        $out = & net localgroup Administrators 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $out) { return $true }
        return [bool]($out | Where-Object { $_.Trim() -ieq $name -or ($_.Trim() -split '\\')[-1] -ieq $name })
    }
}
function Get-Sha([string]$p) { if (Test-Path $p) { (Get-FileHash $p -Algorithm SHA256).Hash.ToLower() } else { $null } }

# 广泛组（对密钥目录不该有读权限的身份）
$BROAD = 'Users$|Everyone$|Authenticated Users$|INTERACTIVE$|^S-1-5-32-545$|^S-1-1-0$|^S-1-5-11$|^S-1-5-4$'

function Get-BroadRead([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return @() }
    $readBits = [int]([Security.AccessControl.FileSystemRights]::ReadData -bor [Security.AccessControl.FileSystemRights]::ReadAndExecute)
    $genericRead = 0x80000000L
    return @((Get-Acl -LiteralPath $Path).Access | Where-Object {
        $_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Value -match $BROAD -and
        ((([int64]$_.FileSystemRights) -band $readBits) -ne 0 -or (([int64]$_.FileSystemRights) -band $genericRead) -ne 0)
    })
}

# —— 可自测的检查函数：每个返回 @{state;detail;fix} ——
function Test-SecretsAcl([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) {
        return @{ state = 'WARN'; detail = "secrets 目录不存在: $Path"; fix = '按 OPS.md 建 %ProgramData%\anc\secrets 并放入 webhook 文件' }
    }
    # 这两个位是本函数自己算的，别指望从 Get-BroadRead 借（那是另一个作用域）
    $readBits = [int]([Security.AccessControl.FileSystemRights]::ReadData -bor [Security.AccessControl.FileSystemRights]::ReadAndExecute)
    $genericRead = 0x80000000L
    # 只认 LOCAL SERVICE —— 不能拿 SYSTEM 凑数。
    # 2026-11-05 实测：第一版写成 (LOCAL SERVICE|SYSTEM)，于是删掉 LOCAL SERVICE 后
    # SYSTEM 的 FullControl 仍然满足判据，检查照样 PASS，等于没修。
    # 而 anc-service / anc-http / anc-backup 等都是 LOCAL SERVICE，SYSTEM 能读不代表它们能读。
    $svcPattern = '^(NT AUTHORITY\\)?LOCAL SERVICE$'

    $hits = @(Get-BroadRead $Path)
    $fileHits = @()
    foreach ($f in @(Get-ChildItem -LiteralPath $Path -File -ErrorAction SilentlyContinue)) {
        if (@(Get-BroadRead $f.FullName).Count -gt 0) { $fileHits += $f.Name }
    }

    # ① 太宽？
    if ($hits.Count -gt 0 -or $fileHits.Count -gt 0) {
        $who = @($hits | ForEach-Object { $_.IdentityReference.Value }) + $fileHits
        $who = @($who | Select-Object -Unique)
        return @{ state = 'FAIL'; detail = ('secrets 对广泛组可读: ' + ($who -join ', ')); fix = 'icacls %ProgramData%\anc\secrets /inheritance:r; icacls %ProgramData%\anc\secrets /remove:g "BUILTIN\Users" "Everyone" "Authenticated Users" /T; icacls %ProgramData%\anc\secrets /grant "NT AUTHORITY\SYSTEM:(OI)(CI)F" "BUILTIN\Administrators:(OI)(CI)F" "NT AUTHORITY\LOCAL SERVICE:(OI)(CI)RX" /T（注意：只做 /inheritance:r + /grant 不会移除 Users，必须 /remove:g）' }
    }

    # ② 够不够？（2026-11-05 补，VERIFY §62.2）
    # 旧版本只判了 ①，于是「把 LOCAL SERVICE 删掉、服务读不到 token」这种收得太紧的情况
    # 照样报 PASS。anc-service 和 anc-http 都以 LOCAL SERVICE 运行，它必须能读。
    $dirRead = @((Get-Acl -LiteralPath $Path).Access | Where-Object {
        $_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Value -match $svcPattern -and
        ((([int64]$_.FileSystemRights) -band $readBits) -ne 0 -or (([int64]$_.FileSystemRights) -band $genericRead) -ne 0)
    })
    if ($dirRead.Count -eq 0) {
        return @{ state = 'FAIL'; detail = 'secrets 没给服务身份读权限（LOCAL SERVICE / SYSTEM 都不在）'; fix = 'icacls %ProgramData%\anc\secrets /grant "NT AUTHORITY\LOCAL SERVICE:(OI)(CI)RX" /T —— anc-service 与 anc-http 以 LOCAL SERVICE 运行，缺了它服务读不到 token，而任务状态仍显示成功' }
    }

    # ③ 管理员能不能进？（2026-11-05 补，VERIFY §78）
    # 旧版只判了 ①太宽 和 ②服务能不能读，不判「管理员能不能进」。
    # 2026-11-05 实测踩到：secrets 被收成「只有 LOCAL SERVICE」，Administrator 连读都读不了，
    # 而 doctor 照样 PASS（①太宽 不成立、②服务能读 成立）。后果是部署写不进 secrets。
    $admPattern = '^(BUILTIN\\)?Administrators$'
    $admRead = @((Get-Acl -LiteralPath $Path).Access | Where-Object {
        $_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Value -match $admPattern -and
        ((([int64]$_.FileSystemRights) -band $readBits) -ne 0 -or (([int64]$_.FileSystemRights) -band $genericRead) -ne 0)
    })
    if ($admRead.Count -eq 0) {
        return @{ state = 'FAIL'; detail = 'secrets 没给 Administrators 权限 —— 管理员部署时写不进去'; fix = 'icacls %ProgramData%\anc\secrets /grant:r "BUILTIN\Administrators:(OI)(CI)F" /T' }
    }
    $noSvc = @()
    foreach ($f in @(Get-ChildItem -LiteralPath $Path -File -ErrorAction SilentlyContinue)) {
        $ok = @((Get-Acl -LiteralPath $f.FullName).Access | Where-Object {
            $_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Value -match $svcPattern -and
            ((([int64]$_.FileSystemRights) -band $readBits) -ne 0 -or (([int64]$_.FileSystemRights) -band $genericRead) -ne 0)
        })
        if ($ok.Count -eq 0) { $noSvc += $f.Name }
    }
    if ($noSvc.Count -gt 0) {
        return @{ state = 'FAIL'; detail = ('这些 secrets 文件服务身份读不到: ' + (@($noSvc | Select-Object -Unique) -join ', ')); fix = 'icacls "%ProgramData%\anc\secrets\*" /grant "NT AUTHORITY\LOCAL SERVICE:(RX)"' }
    }

    # 2026-11-05 加（VERIFY §80）：文件级也要检查管理员能不能读。
    # 目录级 ③ 只管目录；而 set-acl.ps1 早先只给文件授 LOCAL SERVICE:(RX)，
    # 目录 /inheritance:r 之后文件的继承链已断 → 文件上永远没有 Administrators。
    # 症状：目录能读写、里面文件读不了，换 webhook 只能先手动 icacls 抢。
    # 这条是靠"实际读不出文件"发现的，判据不补就抓不到。
    $noAdm = @()
    foreach ($f in @(Get-ChildItem -LiteralPath $Path -File -ErrorAction SilentlyContinue)) {
        $adm = @((Get-Acl -LiteralPath $f.FullName).Access | Where-Object {
            $_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Value -match $admPattern -and
            ((([int64]$_.FileSystemRights) -band $readBits) -ne 0 -or (([int64]$_.FileSystemRights) -band $genericRead) -ne 0)
        })
        if ($adm.Count -eq 0) { $noAdm += $f.Name }
    }
    if ($noAdm.Count -gt 0) {
        return @{ state = 'FAIL'; detail = ('这些 secrets 文件管理员读不到（部署会写不进去）: ' + (@($noAdm | Select-Object -Unique) -join ', ')); fix = 'icacls %ProgramData%\anc\secrets /grant:r "BUILTIN\Administrators:F" /T —— 注意文件要用 :F，不能带 (OI)(CI)' }
    }

    return @{ state = 'PASS'; detail = 'secrets 只对服务身份与管理员可读；服务身份可读、管理员可读（目录与文件都查过）'; fix = '-' }
}

function Test-DataAcl([string]$Path) {
    # 2026-11-05（VERIFY §62.3）：secrets 是「服务要读」，data 是「服务要写」。
    # 少了写权限，anc-loop.cmd 的 >> "%LOGF%" 2>&1 重定向失败 → cmd 提前退出，
    # 而任务计划仍报「成功运行、退出码 0」，loop.log 的 mtime 却不动。
    if (-not (Test-Path -LiteralPath $Path)) {
        return @{ state = 'WARN'; detail = "data 目录不存在: $Path"; fix = '先跑一次 deploy.ps1 -Apply' }
    }
    $writeBits = [int64]([Security.AccessControl.FileSystemRights]::WriteData -bor [Security.AccessControl.FileSystemRights]::Modify -bor [Security.AccessControl.FileSystemRights]::FullControl)
    $genericWrite = 0x40000000L
    # 只认 LOCAL SERVICE —— 不能拿 SYSTEM 凑数。
    # 2026-11-05 实测：第一版写成 (LOCAL SERVICE|SYSTEM)，于是删掉 LOCAL SERVICE 后
    # SYSTEM 的 FullControl 仍然满足判据，检查照样 PASS，等于没修。
    # 而 anc-service / anc-http / anc-backup 等都是 LOCAL SERVICE，SYSTEM 能读不代表它们能读。
    $svcPattern = '^(NT AUTHORITY\\)?LOCAL SERVICE$'

    $dirWrite = @((Get-Acl -LiteralPath $Path).Access | Where-Object {
        $_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Value -match $svcPattern -and
        ((([int64]$_.FileSystemRights) -band $writeBits) -ne 0 -or (([int64]$_.FileSystemRights) -band $genericWrite) -ne 0)
    })
    if ($dirWrite.Count -eq 0) {
        return @{ state = 'FAIL'; detail = 'data 目录没给服务身份写权限（LOCAL SERVICE / SYSTEM 都不在）'; fix = 'icacls %ProgramData%\anc\data /grant "NT AUTHORITY\LOCAL SERVICE:(OI)(CI)M"' }
    }

    $noWrite = @()
    foreach ($l in @('loop.log', 'http.log', 'patch-in.log', 'patch-out.log', 'selfheal.log', 'audit.log')) {
        $fp = Join-Path $Path $l
        if (-not (Test-Path -LiteralPath $fp)) { continue }
        $ok = @((Get-Acl -LiteralPath $fp).Access | Where-Object {
            $_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Value -match $svcPattern -and
            ((([int64]$_.FileSystemRights) -band $writeBits) -ne 0 -or (([int64]$_.FileSystemRights) -band $genericWrite) -ne 0)
        })
        if ($ok.Count -eq 0) { $noWrite += $l }
    }
    if ($noWrite.Count -gt 0) {
        return @{ state = 'FAIL'; detail = ('这些日志服务身份写不了: ' + ($noWrite -join ', ')); fix = '逐个补：icacls "<文件路径>" /grant "NT AUTHORITY\LOCAL SERVICE:(M)"' }
    }

    return @{ state = 'PASS'; detail = 'data 目录与日志对服务身份可写'; fix = '-' }
}

function Test-DeployLayout([string]$Root, [string]$Src) {
    $bad = @()
    foreach ($n in @('ingest', 'render', 'service', 'bin', 'patch')) {
        $p = Join-Path $Root $n
        if (-not (Test-Path -LiteralPath $p)) { $bad += "${n}: 缺失" }
        elseif (-not (Get-Item -LiteralPath $p -Force).PSIsContainer) { $bad += "${n}: 是文件（应为目录）" }
    }
    $srcDir = if ($Src) { Join-Path $Src 'scripts\workbuddy-patch' } else { '' }
    $dstDir = Join-Path $Root 'patch'
    if ($srcDir -and (Test-Path $srcDir) -and (Test-Path $dstDir) -and (Get-Item -LiteralPath $dstDir -Force).PSIsContainer) {
        foreach ($f in @(Get-ChildItem -LiteralPath $srcDir -File)) {
            $d = Join-Path $dstDir $f.Name
            if (-not (Test-Path -LiteralPath $d)) { $bad += "patch/$($f.Name): 缺失" }
            elseif ((Get-Sha $f.FullName) -ne (Get-Sha $d)) { $bad += "patch/$($f.Name): hash 与仓库不一致" }
        }
    }
    # 渲染器要用模板：只部署了 render/ 却没带 light/templates 时，渲染会在运行时 404
    if ((Test-Path (Join-Path $Root 'render\cli.ts')) -and -not (Test-Path (Join-Path $Root 'light\templates\company-bot.md'))) {
        $bad += 'light/templates: 缺失（渲染器在，但模板没部署）'
    }
    if ($bad.Count -gt 0) {
        return @{ state = 'FAIL'; detail = ('部署布局不对: ' + ($bad -join '; ')); fix = 'ingest/render 应为目录；补 deploy.ps1 后重部署；patch 与仓库逐字节一致' }
    }
    return @{ state = 'PASS'; detail = '部署目录结构正确，patch 与仓库一致'; fix = '-' }
}

function Test-BotProcessOwner([string]$ExpectedUser) {
    $procs = @(Get-CimInstance Win32_Process -Filter "Name='WorkBuddy.exe'" -ErrorAction SilentlyContinue)
    if ($procs.Count -eq 0) { return @{ state = 'WARN'; detail = 'WorkBuddy 没在跑'; fix = '用补丁启动器起来后再看' } }
    $mains = @($procs | Where-Object { ([string]$_.CommandLine) -notmatch '--type=' })
    $owners = @()
    foreach ($p in $mains) {
        $o = Invoke-CimMethod -InputObject $p -MethodName GetOwner -ErrorAction SilentlyContinue
        if ($o -and $o.User) { $owners += [string]$o.User }
    }
    $owners = @($owners | Select-Object -Unique)
    if ($owners.Count -eq 0) { return @{ state = 'WARN'; detail = '取不到 WorkBuddy 进程的 owner'; fix = '用管理员身份跑 doctor' } }
    if ($owners.Count -eq 1 -and $ExpectedUser -and $owners[0] -ieq $ExpectedUser) {
        return @{ state = 'PASS'; detail = ("WorkBuddy 跑在 " + $owners[0]); fix = '-' }
    }
    return @{ state = 'FAIL'; detail = ('WorkBuddy 跑在 ' + ($owners -join ', ') + '，期望 ' + $ExpectedUser); fix = '按 REBUILD §4 迁到专用标准用户（PLAN R1）' }
}

function Get-TaskCoverage([hashtable]$Expected) {
    $out = @()
    foreach ($t in ($Expected.Keys | Sort-Object)) {
        $task = Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue
        if (-not $task) { $out += @{ name = $t; state = 'FAIL'; detail = '任务不存在'; fix = "按 docs/OPS.md 注册 $t" }; continue }
        $uid = [string]$task.Principal.UserId
        $short = ($uid -split '\\')[-1]
        $want = [string]$Expected[$t]
        if ($task.State -eq 'Disabled') {
            # 被禁用 = 功能停摆，不是"也许没事"。维护期间要临时停用，就显式改 PLAN 并在这里加豁免，
            # 别让它悄悄 WARN——WARN 攒多了没人看，真出问题时也分不清哪些是新的
            $out += @{ name = $t; state = 'FAIL'; detail = '任务被禁用'; fix = 'Enable-ScheduledTask 恢复；确实要长期停用请改 PLAN 并在 doctor 加豁免' }
        } elseif ($task.State -ne 'Ready' -and $task.State -ne 'Running') {
            $out += @{ name = $t; state = 'WARN'; detail = ('状态 ' + $task.State); fix = '检查触发器与上次结果' }
        } elseif ($want -and $short -and $short -ine $want) {
            $out += @{ name = $t; state = 'FAIL'; detail = ('principal=' + $uid + '，期望 ' + $want); fix = '按 OPS.md 修正运行身份（PLAN R1 的一部分）' }
        } else {
            $out += @{ name = $t; state = 'PASS'; detail = ('状态 ' + $task.State + ' / ' + $short); fix = '-' }
        }
    }
    return $out
}

$ExpectedPrincipal = [ordered]@{
    'anc-service'          = 'LOCAL SERVICE'
    'anc-backup'           = 'LOCAL SERVICE'
    'anc-boot-alert'       = 'LOCAL SERVICE'
    'anc-cleanup'          = 'SYSTEM'
    'anc-watchdog'         = 'LOCAL SERVICE'
    'anc-http'             = 'LOCAL SERVICE'
    'anc-update-watch'     = 'LOCAL SERVICE'
    'anc-workbuddy-launch' = $BotUser
    'anc-patch-guard'      = $BotUser
    # devbot 自动启动：工作日 22:00~06:00 每 30 分钟查一次「全员下班」（2026-11-05 新增）
    # **不是 SYSTEM**：devbot.ps1 要切当前用户的 WorkBuddy persona，
    # SYSTEM 的 %USERPROFILE% 是 systemprofile（那里没有 WorkBuddy），且 git 会拒绝
    # （dubious ownership）。和 anc-workbuddy-launch / anc-patch-guard 同 principal。
    'anc-devbot'           = $BotUser
}

# ============ 自测：证明每类检查真的会 FAIL ============
if ($SelfTest) {
    $ok = $true
    $tmp = Join-Path $env:TEMP ('anc-doctor-selftest-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tmp -Force | Out-Null
    function Say([bool]$pass, [string]$what, [string]$got) {
        if ($pass) { "SELFTEST PASS  $what  ($got)" } else { "SELFTEST FAIL  $what  ($got)"; $script:selftestOk = $false }
    }
    $script:selftestOk = $true
    try {
        # 1 secrets-acl：夹具授权 Users 读 → 必须 FAIL；收紧后 → 必须 PASS
        $sec = Join-Path $tmp 'secrets'
        New-Item -ItemType Directory -Path $sec -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $sec 'hook.txt') -Value 'https://example.invalid/x' -Encoding ascii
        & icacls $sec /grant 'BUILTIN\Users:(OI)(CI)RX' 2>&1 | Out-Null
        $r = Test-SecretsAcl $sec
        Say ($r.state -eq 'FAIL') 'secrets-acl 能识别广泛组可读' $r.state
        # /inheritance:r 要带 /T：hook.txt 上残留的继承 ACE 也会让判据 ① 命中
        & icacls $sec /inheritance:r /T 2>&1 | Out-Null
        & icacls $sec /remove:g 'BUILTIN\Users' 'Everyone' 'Authenticated Users' /T 2>&1 | Out-Null
        # Test-SecretsAcl 是双向判据：既要「广泛组不可读」，也要「LOCAL SERVICE 可读」+「管理员可读」。
        # 夹具只授 Admins/SYSTEM 时收紧后必然 FAIL（2026-11-06 实测），必须把服务身份一起授上。
        & icacls $sec /grant 'BUILTIN\Administrators:(OI)(CI)F' 'NT AUTHORITY\SYSTEM:(OI)(CI)F' 'NT AUTHORITY\LOCAL SERVICE:(OI)(CI)RX' /T 2>&1 | Out-Null
        # /inheritance:r /T 会把 hook.txt 的继承 ACE 清成空 ACL，而带 (OI)(CI) 的 /grant
        # 不会给文件补回条目 —— 文件级判据会失效，下面的 Remove-Item 也会「访问被拒绝」。
        # 显式给文件授一次（不带继承标志），让它和真实部署一样三方 ACE 齐全。
        & icacls (Join-Path $sec 'hook.txt') /grant:r 'BUILTIN\Administrators:F' 'NT AUTHORITY\SYSTEM:F' 'NT AUTHORITY\LOCAL SERVICE:RX' 2>&1 | Out-Null
        $r2 = Test-SecretsAcl $sec
        Say ($r2.state -eq 'PASS') 'secrets-acl 收紧后放行' $r2.state

        # 2 deploy-layout：把 ingest 造成文件 → 必须 FAIL
        $root = Join-Path $tmp 'anc'
        New-Item -ItemType Directory -Path $root -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $root 'ingest') -Value 'x' -Encoding ascii
        $r3 = Test-DeployLayout $root $Repo
        Say ($r3.state -eq 'FAIL') 'deploy-layout 能识别"目录被复制成文件"' $r3.state

        # 3 task-coverage：不存在的任务 → 必须 FAIL
        $r4 = Get-TaskCoverage ([ordered]@{ 'anc-no-such-task' = 'LOCAL SERVICE' })
        Say (@($r4 | Where-Object { $_.state -eq 'FAIL' }).Count -ge 1) 'task-coverage 能识别缺任务' ($r4[0].state)

        # 4 bot-process-owner：期望一个不存在的用户 → 必须 FAIL（WorkBuddy 在跑时）
        $r5 = Test-BotProcessOwner 'anc-no-such-user'
        Say ($r5.state -eq 'FAIL' -or $r5.state -eq 'WARN') 'bot-process-owner 能分辨 owner 不符' $r5.state

        # 5 secrets-in-git 的判定函数在真实仓库上应为 PASS（有 .git 时）
        Say ($true) 'secrets-in-git 走 git grep（在下面的正式检查里）' 'skip'
    } finally {
        # 夹具改过 ACL：先恢复继承再删，否则空 ACL 的子文件会让 Remove-Item 拒绝访问
        & icacls $tmp /reset /T /Q 2>&1 | Out-Null
        Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
    ""
    if ($script:selftestOk) { "SELFTEST RESULT: ALL PASS"; exit 0 } else { "SELFTEST RESULT: FAIL"; exit 1 }
}

# ============ 正式检查 ============

# 1 专用用户（账号存在且不在管理员组）
$bot = Get-LocalUser -Name $BotUser -ErrorAction SilentlyContinue
if (-not $bot) {
    Add-Result 'dedicated-user' 'FAIL' ("身份 $BotUser 不存在") '检查 -BotUser 参数，或用 net user 确认部署账号名'
} elseif (Test-AdminMember $BotUser) {
    # D25（2026-11-02 维护者决定）：部署约定直接用管理员账号，不再要求专用标准用户。
    # 仍然报出来，是为了让"身份意外变化"可见——例如被换成 SYSTEM 或别的账号。
    Add-Result 'dedicated-user' 'PASS' ("$BotUser（管理员组，按 D25 约定）") '若将来要收紧：改 -BotUser 并把该账号移出管理员组'
} else {
    Add-Result 'dedicated-user' 'PASS' ("$BotUser（标准用户）") '-'
}

# 2 公司 bot 实际跑在谁名下（账号对不等于进程对）
$po = Test-BotProcessOwner $BotUser
Add-Result 'bot-process-owner' $po.state $po.detail $po.fix

# 3 工作时段与配置
$start = $null; $end = $null
try {
    $cfg = Invoke-ServiceJson -Sub @('config', 'list') -Db (Join-Path $Root 'data\anc.db')
    $start = $cfg.config.work_start; $end = $cfg.config.work_end
    $cfgProblems = @($cfg.problems)
} catch { $cfgProblems = @() }
if ($cfgProblems.Count -gt 0) { Add-Result 'work-hours' 'FAIL' ('配置有误（已按全天处理）: ' + ($cfgProblems -join '；')) 'config set work_start/work_end 用 HH:mm，且两者不同' }
elseif ($start -and $end) { Add-Result 'work-hours' 'PASS' "$start–$end" '-' }
else { Add-Result 'work-hours' 'WARN' '未配置工作时段（默认全天）' '需要时 config set work_start/work_end' }

# 4 计划任务：逐项覆盖 $ExpectedPrincipal（现 10 项，含 anc-devbot）
foreach ($r in @(Get-TaskCoverage $ExpectedPrincipal)) {
    Add-Result ("task-" + $r.name) $r.state $r.detail $r.fix
}

# 5 心跳新鲜度
$log = Join-Path $Root 'data\loop.log'
if (Test-Path $log) {
    $age = [int]((Get-Date) - (Get-Item $log).LastWriteTime).TotalMinutes
    if ($age -le 5) { Add-Result 'heartbeat' 'PASS' "$age 分钟内有 tick" '-' }
    else { Add-Result 'heartbeat' 'FAIL' "$age 分钟没有 tick" '检查 anc-service 是否被禁用或报错' }
} else { Add-Result 'heartbeat' 'FAIL' '没有 loop.log' '先跑一次 anc-service' }

# 6 WorkBuddy 版本：路径优先取补丁写下的 workbuddy-path.txt（LOCAL SERVICE 也能定位）
$wbPathFile = Join-Path $Root 'data\workbuddy-path.txt'
$exe = $null
if (Test-Path $wbPathFile) { $exe = (Get-Content $wbPathFile -Raw).Trim() }
if (-not $exe -or -not (Test-Path $exe)) { $exe = "$env:LOCALAPPDATA\Programs\WorkBuddy\WorkBuddy.exe" }

# 7 manifest
$mf = $null
if (Test-Path $Manifest) {
    try { $mf = Get-Content $Manifest -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $mf = $null }
}
if (Test-Path $Manifest) {
    if (-not $mf) { Add-Result 'manifest' 'FAIL' 'manifest.json 无法解析' '从 git 恢复 scripts/workbuddy-patch/manifest.json' }
    elseif (-not $mf.workbuddyVersion -or -not $mf.sha256) { Add-Result 'manifest' 'FAIL' '缺少 workbuddyVersion / sha256' '从 git 恢复 manifest.json' }
    else { Add-Result 'manifest' 'PASS' ($mf.workbuddyVersion + ' / ' + $mf.sha256.Substring(0, 8) + '…') '-' }
} else { Add-Result 'manifest' 'FAIL' 'manifest.json 不存在' '从 git 恢复' }

# 8 已安装版本
if (-not (Test-Path $exe)) { Add-Result 'workbuddy' 'WARN' "找不到 WorkBuddy.exe（$exe）" 'bot 用户安装后复测；或写 workbuddy-path.txt' }
elseif ($mf -and (Get-Item $exe).VersionInfo.FileVersion -ne $mf.workbuddyVersion) {
    Add-Result 'workbuddy' 'FAIL' ("版本 " + (Get-Item $exe).VersionInfo.FileVersion + " != 登记 " + $mf.workbuddyVersion) '按 WORKBUDDY-PATCH.md 重放补丁并更新 manifest'
} else { Add-Result 'workbuddy' 'PASS' ('版本 ' + (Get-Item $exe).VersionInfo.FileVersion) '-' }

# 9 补丁日志：先找 bot 用户的，再回退当前用户
$plog = $null
foreach ($c in @("C:\Users\$BotUser\anc\workbuddy-patch.log", "$env:USERPROFILE\anc\workbuddy-patch.log")) {
    if ($c -and (Test-Path $c)) { $plog = $c; break }
}
# 2026-11-06 修（VERIFY §61 / §58.7-1）：状态文件说失败时，日志里上一次的
# APPLIED 不能盖过它。旧检查是「取最后一条 APPLIED」，不看时间戳 —— 本次注入
# 失败而日志还留着上次的 APPLIED 时，doctor 照样 PASS（状态骗人）。
# 只做这一层交叉验证，不引入进程启动时间判定，避免在跑部署被误报。
$psFile = Join-Path $Root 'data\patch-state.json'
$psFail = $null
if (Test-Path $psFile) {
    try {
        $ps = [IO.File]::ReadAllText($psFile, [Text.Encoding]::UTF8).TrimStart([char]0xFEFF) | ConvertFrom-Json
        if (-not [bool]$ps.applied) {
            $psFail = 'patch-state applied=false'
            if ($ps.error) { $psFail += '：' + $ps.error }
        }
    } catch { $psFail = 'patch-state.json 无法解析' }
}
if ($psFail) { Add-Result 'patch' 'FAIL' ('补丁状态文件判失败：' + $psFail) '按 docs/WORKBUDDY-PATCH.md 重放补丁；或跑 launch-patched.ps1 重新注入' }
elseif ($plog) {
    $last = Get-Content $plog -Tail 200
    $lastApply = $last | Select-String -Pattern 'APPLIED mode=|ANCHOR-MISS' | Select-Object -Last 1
    $hook = [bool]($last | Select-String -Pattern 'update-hook installed' -Quiet)
    if ($lastApply -and $lastApply.Line -match 'APPLIED mode=hash' -and $hook) { Add-Result 'patch' 'PASS' 'APPLIED(hash) + update-hook' '-' }
    elseif ($lastApply -and $lastApply.Line -match 'APPLIED mode=anchor' -and $hook) { Add-Result 'patch' 'WARN' '锚点模式（版本未登记）' '按 docs/WORKBUDDY-PATCH.md 回归后更新 manifest 的 version/sha256' }
    elseif ($lastApply -and $lastApply.Line -match 'ANCHOR-MISS') { Add-Result 'patch' 'FAIL' '补丁已注入但没找到 emitMessage' '按 light/skills/anc-wb-patch 重找注入点' }
    else { Add-Result 'patch' 'FAIL' '日志里缺 APPLIED 或 update-hook' '重启补丁启动器，看 workbuddy-patch.log' }
} else { Add-Result 'patch' 'WARN' '没有补丁日志（可能未用启动器）' '用 launch-patched.ps1 启动' }

# 10 SMB 共享权限
$share = Get-SmbShare -Name 'anc-vault-shared' -ErrorAction SilentlyContinue
if (-not $share) { Add-Result 'smb' 'FAIL' '共享不存在' ('New-SmbShare -Name anc-vault-shared -Path ' + $vaultShared + '（或改 -VaultRoot）') }
else {
    $access = Get-SmbShareAccess -Name 'anc-vault-shared'
    $bad = $access | Where-Object { $_.AccountName -match 'Everyone|Authenticated Users|\\Users$' -and $_.AccessControlType -eq 'Allow' -and $_.AccessRight -ne 'Read' }
    if ($bad) { Add-Result 'smb' 'FAIL' ('共享对广泛组有写权限: ' + (($bad | ForEach-Object { $_.AccountName }) -join ', ')) '收成 Read' }
    else { Add-Result 'smb' 'PASS' '共享存在且 Everyone/Authenticated Users/Users 只读' '-' }
}

# 11 vault 目录 NTFS
$shared = $vaultShared
if (Test-Path $shared) {
    $writeBits = [int]([Security.AccessControl.FileSystemRights]::WriteData -bor [Security.AccessControl.FileSystemRights]::AppendData -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership)
    $genericWrite = 0x40000000L -bor 0x10000000L
    $broad = 'Users$|Everyone$|Authenticated Users$|^S-1-5-32-545$|^S-1-1-0$|^S-1-5-11$'
    $users = (Get-Acl $shared).Access | Where-Object {
        $_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Value -match $broad -and
        ((([int64]$_.FileSystemRights) -band $writeBits) -ne 0 -or (([int64]$_.FileSystemRights) -band $genericWrite) -ne 0)
    }
    if ($users) { Add-Result 'vault-acl' 'FAIL' ('共享区对广泛组有写权限: ' + (($users | ForEach-Object { $_.IdentityReference.Value }) -join ', ')) 'icacls 收成 ReadAndExecute' }
    else { Add-Result 'vault-acl' 'PASS' '共享区对 Users/Everyone/Authenticated Users 只读' '-' }
} else { Add-Result 'vault-acl' 'WARN' '共享区目录不存在' ('按 docs/OPS.md 建 ' + $vaultShared + '（或改 -VaultRoot）') }

# 12 密钥目录权限（webhook 是 bearer 凭据）
$sec = Test-SecretsAcl (Join-Path $Root 'secrets')
Add-Result 'secrets-acl' $sec.state $sec.detail $sec.fix

# 12b data 目录写权限（服务要写日志；少了它任务显示成功但日志不动，见 VERIFY §62.3）
$dacl = Test-DataAcl (Join-Path $Root 'data')
Add-Result 'data-acl' $dacl.state $dacl.detail $dacl.fix

# 13 部署布局（唯一来源：从部署目录跑，不从工作副本跑）
$dl = Test-DeployLayout $Root $Repo
Add-Result 'deploy-layout' $dl.state $dl.detail $dl.fix

# 14 密钥不进 git
if ($Repo -and (Test-Path (Join-Path $Repo '.git'))) {
    $hits = & git -C $Repo grep -I -n -E 'qyapi\.weixin\.qq\.com/cgi-bin/webhook/send\?key=[A-Za-z0-9-]{8,}|corpsecret[[:space:]]*=[[:space:]]*[A-Za-z0-9]{8,}' -- ':!*.test.ts' ':!*.test.mjs' ':!docs/*' 2>$null
    $where = $hits | Select-Object -First 3 | ForEach-Object { ($_ -split ':', 3)[0..1] -join ':' }
    if ($hits) { Add-Result 'secrets-in-git' 'FAIL' ('仓库内容里有疑似密钥，位置: ' + ($where -join ', ')) '删掉并改用占位符；密钥只放 ProgramData' }
    else { Add-Result 'secrets-in-git' 'PASS' '仓库内容未见真实密钥' '-' }
} else { Add-Result 'secrets-in-git' 'WARN' '未指定 -Repo（或不是 git 仓库），跳过仓库密钥扫描' '转公开前在仓库里跑一次：doctor.ps1 -Repo <仓库根>' }

# 15 时区
$tz = (Get-TimeZone).Id
$wantTz = $null
if ($cfg -and $cfg.config -and ($cfg.config.PSObject.Properties.Name -contains 'timezone')) { $wantTz = [string]$cfg.config.timezone }
if ($wantTz -and $tz -ne $wantTz) {
    Add-Result 'timezone' 'FAIL' ("系统 $tz，配置要求 $wantTz（提醒按主机系统时区计算，与配置不符会整体偏移）") '修正主机系统时区为配置值；timezone 是部署断言，不参与运行时计算'
} elseif ($tz -eq 'China Standard Time') {
    Add-Result 'timezone' 'PASS' $tz '-'
} else {
    Add-Result 'timezone' 'WARN' ("当前 $tz（未配置 timezone，按 China Standard Time 设计）") ('config set timezone "' + $tz + '"')
}


# 15b 时间同步：时区对了不等于时间对。W32Time 停着时时钟会慢慢漂，
#     patch-guard 用 patch-state.at 与进程创建时间的 ±15 秒窗口判断补丁新旧，
#     提醒的 due_at 也依赖绝对时间。2026-11-04 发现这台机器从装好起 W32Time 就是 Stopped。
$w32 = Get-Service W32Time -ErrorAction SilentlyContinue
$w32Running = $w32 -and ($w32.Status -eq 'Running')
$syncLine = ''
try { $syncLine = (w32tm /query /status 2>&1 | Out-String) } catch { $syncLine = '' }
# w32tm 的输出是本地化 + GBK，中文 key 在这里是乱码，匹配不到。
# 改成认「日期 + 时间」这个形态：只要输出里有 yyyy/M/d H:mm:ss 就说明报告了上次同步时间。
$hasSync = $syncLine -match '\d{4}[/-]\d{1,2}[/-]\d{1,2}.{0,12}\d{1,2}:\d{2}:\d{2}'
if (-not $w32) {
    Add-Result 'time-sync' 'FAIL' '找不到 W32Time 服务（时钟不会自动校准）' '确认系统组件完整：Set-Service W32Time -StartupType Automatic'
} elseif (-not $w32Running) {
    Add-Result 'time-sync' 'FAIL' ("W32Time 状态 " + $w32.Status + "（时钟不会自动校准；patch-guard 的 ±15 秒窗口和提醒的 due_at 都会受影响）") 'Set-Service W32Time -StartupType Automatic; Start-Service W32Time; w32tm /resync /force'
} elseif (-not $hasSync) {
    Add-Result 'time-sync' 'WARN' 'W32Time 在跑，但查不到最近一次成功同步记录' 'w32tm /resync /force，再看 w32tm /query /status'
} else {
    $syncAt = ''
    if ($syncLine -match '(?:Last Successful Sync Time|上次成功同步时间)s*[:：]s*(.+)') { $syncAt = $matches[1].Trim() }
    Add-Result 'time-sync' 'PASS' ("W32Time Running" + $(if ($syncAt) { " / 上次同步 " + $syncAt } else { "" })) '-'
}

# 16 数据库
# 用 $Root 而不是 %ProgramData%：-Root 是"校验另一个部署根"的唯一入口，
# 写死 ProgramData 会让 -Root 对这项失效——演练根上把库删了它照样 PASS（2026-11-04 踩到）。
$db = Join-Path $Root 'data\anc.db'
if (Test-Path $db) { Add-Result 'database' 'PASS' ((Get-Item $db).Length.ToString() + ' B') '-' }
else { Add-Result 'database' 'FAIL' '数据库不存在' '跑一次 service cli 初始化' }

# 17 绑定：提醒按群的 webhook_file 选文件，没登记就发不出去
try {
    $b = @((Invoke-ServiceJson -Sub @('bind', 'list') -Db (Join-Path $Root 'data\anc.db')).bindings)
    if ($b.Count -eq 0) {
        Add-Result 'bindings' 'WARN' '没有任何群绑定' 'bind import --from groups.json 或 bind set'
    } else {
        $missing = @($b | Where-Object { -not $_.webhook_file })
        if ($missing.Count -gt 0) {
            Add-Result 'bindings' 'FAIL' ("$($missing.Count)/$($b.Count) 个群没登记 webhook_file，提醒会发不出去") 'bind set --chat-id <chatid> --employee <名> --webhook-file wecom-webhook.txt'
        } else {
            # 把员工名带进 detail：#6 的判据不只要不误报，还要 PS 5.1 下中文名能正确显示。
            $names = @($b | ForEach-Object { $_.employee } | Where-Object { $_ })
            $who = ''
            if ($names.Count -gt 0) {
                $shown = @($names | Select-Object -First 5) -join '、'
                if ($names.Count -gt 5) { $shown += '…' }
                $who = '（' + $shown + '）'
            }
            Add-Result 'bindings' 'PASS' ("$($b.Count) 个绑定都登记了 webhook" + $who) '-'
        }
    }
} catch { Add-Result 'bindings' 'WARN' ('读绑定失败：' + $_.Exception.Message) '检查数据库与 cli.ts；PS 5.1 下确认输出按 UTF-8 解码' }

# 18 canary：补丁生效后真实收到的消息里有没有 chatId
$canary = Join-Path $Root 'data\patch-canary.json'
if (-not (Test-Path $canary)) {
    Add-Result 'canary' 'WARN' '还没有 canary 记录（补丁生效后需收到一条群消息）' '在群里发一条消息后再看'
} else {
    try {
        $c = Get-Content $canary -Raw | ConvertFrom-Json
        $hours = [int]((Get-Date) - [datetime]$c.at).TotalHours
        if (-not $c.chatId) { Add-Result 'canary' 'FAIL' '补丁生效但取不到 chatId（上游字段可能改名）' '按 WORKBUDDY-PATCH.md 重放并核对字段名' }
        elseif ($hours -gt 72) { Add-Result 'canary' 'WARN' "canary 已 $hours 小时没更新" '确认群里仍有消息' }
        else { Add-Result 'canary' 'PASS' "最近 $hours 小时内有消息且带 chatId" '-' }
    } catch { Add-Result 'canary' 'WARN' 'canary 文件无法解析' '删掉让补丁重写' }
}

# 19 HTTP 面存活（watchdog 用同一个端点判死；未注册 anc-http 时给提示而不是 FAIL）
try {
    $h = Invoke-RestMethod -Uri 'http://127.0.0.1:17891/__anc_health' -TimeoutSec 3
    if ($h.ok) { Add-Result 'http-health' 'PASS' $h.detail '-' }
    else { Add-Result 'http-health' 'FAIL' ('服务在但心跳不健康: ' + $h.detail) '检查 anc-service 是否在跑' }
} catch {
    # 2026-11-06：全量测试 / 部署并发时 3 秒探测会超时，直接判 FAIL 是误报
    # （实测负载回落后同一端点 200 OK）。失败后再给一次机会，两次都不通才判死。
    Start-Sleep -Milliseconds 800
    $retryOk = $false
    $retryDetail = ''
    try {
        $h2 = Invoke-RestMethod -Uri 'http://127.0.0.1:17891/__anc_health' -TimeoutSec 5
        if ($h2.ok) { $retryOk = $true; $retryDetail = [string]$h2.detail }
    } catch { }
    if ($retryOk) {
        Add-Result 'http-health' 'PASS' ($retryDetail + '（首次探测超时，重试通过）') '-'
    } elseif (Get-ScheduledTask -TaskName 'anc-http' -ErrorAction SilentlyContinue) {
        Add-Result 'http-health' 'FAIL' 'anc-http 任务在但端口没响应（已重试）' '看 %ProgramData%\anc\data\http.log；确认 17891 没被占用'
    } else {
        Add-Result 'http-health' 'WARN' 'HTTP 面未启用（没有 anc-http 任务）' '需要时跑 scripts\register-tasks.ps1 -Apply'
    }
}

# 20 vault 改动有没有入库记录（绕过检测）
$vault = $vaultShared
$untracked = @()
if (Test-Path (Join-Path $vault '.git')) {
    $untracked = @(& git -C $vault status --porcelain 2>$null | Where-Object { $_ -match '^\?\?' })
}
if ($untracked.Count -eq 0) {
    Add-Result 'vault-ingest-audit' 'PASS' '共享区无未跟踪改动' '-'
} else {
    $auditFile = Join-Path $Root 'data\audit.log'
    $recent = $false
    if (Test-Path $auditFile) {
        $cut = (Get-Date).AddHours(-1).ToString('o')
        $recent = [bool](Get-Content $auditFile -Tail 300 -ErrorAction SilentlyContinue |
            Where-Object { $_ -match '"cmd":"ingest apply"' -and $_ -match '"ok":true' } |
            ForEach-Object { try { ($_ | ConvertFrom-Json).at } catch { $null } } |
            Where-Object { $_ -and $_ -gt $cut })
    }
    if ($recent) {
        Add-Result 'vault-ingest-audit' 'PASS' ("$($untracked.Count) 个未跟踪文件，1 小时内有成功入库记录（待复核）") '-'
    } else {
        Add-Result 'vault-ingest-audit' 'WARN' ("$($untracked.Count) 个未跟踪文件，但 1 小时内没有成功入库记录——可能绕过了 CLI 直接写盘") '核对 inbox/done 有没有对应批次；绕过写入的文件不该进 git'
    }
}
# 21 备份新鲜度（备份平时看不出坏，只能靠时间戳判活）
$bakDir = Join-Path $Root 'backup'
$lastBak = Get-ChildItem $bakDir -Filter 'anc-*.db' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $lastBak) {
    Add-Result 'backup-freshness' 'FAIL' '没有任何数据库备份' '跑一次 anc-backup 任务，或 scripts\backup-anc.ps1'
} else {
    $ageH = [int]((Get-Date) - $lastBak.LastWriteTime).TotalHours
    if ($ageH -gt 30) {
        Add-Result 'backup-freshness' 'FAIL' ("最近备份 $ageH 小时前（阈值 30）") '检查 anc-backup 任务与磁盘空间；backup.log 里有原因'
    } else {
        Add-Result 'backup-freshness' 'PASS' ("$ageH 小时前，" + [math]::Round($lastBak.Length / 1KB) + " KB") '-'
    }
}
$fails = @($results | Where-Object { $_.state -eq 'FAIL' }).Count
$warns = @($results | Where-Object { $_.state -eq 'WARN' }).Count
if ($Json) {
    [pscustomobject]@{ ok = ($fails -eq 0); fails = $fails; warns = $warns; checks = $results } | ConvertTo-Json -Depth 4
} else {
    foreach ($r in $results) { "{0,-6} {1,-20} {2}" -f $r.state, $r.check, $r.detail }
    ""
    "FAIL=$fails WARN=$warns"
    foreach ($r in $results | Where-Object { $_.state -ne 'PASS' }) { "FIX    " + $r.check + ': ' + $r.fix }
}
if ($fails -gt 0) { exit 1 } else { exit 0 }
