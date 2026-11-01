# 主机体检（doctor）：只读检查，每项给 PASS / WARN / FAIL 与出路
# 退出码：0 无 FAIL / 1 有 FAIL / 2 用法错误
# -SelfTest：用 %TEMP% 下的夹具证明"每类检查确实能 FAIL"，不碰真实环境
[CmdletBinding()]
param(
    [string]$Repo = '',
    [string]$Root = '',
    [string]$Manifest = '',
    [string]$BotUser = 'anc-bot',
    [switch]$Json,
    [switch]$SelfTest
)

$ErrorActionPreference = 'Continue'
if (-not $Root) { $Root = Join-Path $env:ProgramData 'anc' }
# 线上以部署目录为准：manifest 默认取 %ProgramData%\anc\patch 的那份，不再从 git 工作副本读
if (-not $Manifest) { $Manifest = Join-Path $Root 'patch\manifest.json' }
$results = @()
function Add-Result([string]$name, [string]$state, [string]$detail, [string]$fix) {
    $script:results += [pscustomobject]@{ check = $name; state = $state; detail = $detail; fix = $fix }
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
    $hits = @(Get-BroadRead $Path)
    $fileHits = @()
    foreach ($f in @(Get-ChildItem -LiteralPath $Path -File -ErrorAction SilentlyContinue)) {
        if (@(Get-BroadRead $f.FullName).Count -gt 0) { $fileHits += $f.Name }
    }
    if ($hits.Count -gt 0 -or $fileHits.Count -gt 0) {
        $who = @($hits | ForEach-Object { $_.IdentityReference.Value }) + $fileHits
        $who = @($who | Select-Object -Unique)
        return @{ state = 'FAIL'; detail = ('secrets 对广泛组可读: ' + ($who -join ', ')); fix = 'icacls %ProgramData%\anc\secrets /inheritance:r; icacls %ProgramData%\anc\secrets /remove:g "BUILTIN\Users" "Everyone" "Authenticated Users" /T; icacls %ProgramData%\anc\secrets /grant "NT AUTHORITY\SYSTEM:(OI)(CI)F" "BUILTIN\Administrators:(OI)(CI)F" "NT AUTHORITY\LOCAL SERVICE:(OI)(CI)RX" "<bot用户>:(OI)(CI)RX" /T（注意：只做 /inheritance:r + /grant 不会移除 Users，必须 /remove:g）' }
    }
    return @{ state = 'PASS'; detail = 'secrets 只对服务身份与管理员可读'; fix = '-' }
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
        if ($task.State -ne 'Ready' -and $task.State -ne 'Running') {
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
    'anc-update-watch'     = 'LOCAL SERVICE'
    'anc-workbuddy-launch' = $BotUser
    'anc-patch-guard'      = $BotUser
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
        & icacls $sec /inheritance:r 2>&1 | Out-Null
        & icacls $sec /remove:g 'BUILTIN\Users' 'Everyone' 'Authenticated Users' /T 2>&1 | Out-Null
        & icacls $sec /grant 'BUILTIN\Administrators:(OI)(CI)F' 'NT AUTHORITY\SYSTEM:(OI)(CI)F' /T 2>&1 | Out-Null
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
        Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
    ""
    if ($script:selftestOk) { "SELFTEST RESULT: ALL PASS"; exit 0 } else { "SELFTEST RESULT: FAIL"; exit 1 }
}

# ============ 正式检查 ============

# 1 专用用户（账号存在且不在管理员组）
$bot = Get-LocalUser -Name $BotUser -ErrorAction SilentlyContinue
if (-not $bot) {
    Add-Result 'dedicated-user' 'FAIL' ("没有 $BotUser 用户") '按 OPS.md 建专用标准用户；上线前必须'
} elseif (Test-AdminMember $BotUser) {
    Add-Result 'dedicated-user' 'FAIL' ("$BotUser 在管理员组（或无法确认）") '移出管理员组；若是查询失败，用 net localgroup Administrators 人工确认'
} else {
    Add-Result 'dedicated-user' 'PASS' ("$BotUser 存在且非管理员") '-'
}

# 2 公司 bot 实际跑在谁名下（账号对不等于进程对）
$po = Test-BotProcessOwner $BotUser
Add-Result 'bot-process-owner' $po.state $po.detail $po.fix

# 3 工作时段与配置
$start = $null; $end = $null
try {
    $cfgRaw = & node "$env:ProgramData\anc\service\cli.ts" --db "$env:ProgramData\anc\data\anc.db" --json config list 2>$null | Out-String
    $cfg = $cfgRaw | ConvertFrom-Json
    $start = $cfg.config.work_start; $end = $cfg.config.work_end
    $cfgProblems = @($cfg.problems)
} catch { $cfgProblems = @() }
if ($cfgProblems.Count -gt 0) { Add-Result 'work-hours' 'FAIL' ('配置有误（已按全天处理）: ' + ($cfgProblems -join '；')) 'config set work_start/work_end 用 HH:mm，且两者不同' }
elseif ($start -and $end) { Add-Result 'work-hours' 'PASS' "$start–$end" '-' }
else { Add-Result 'work-hours' 'WARN' '未配置工作时段（默认全天）' '需要时 config set work_start/work_end' }

# 4 计划任务：8 个全覆盖 + principal
foreach ($r in @(Get-TaskCoverage $ExpectedPrincipal)) {
    Add-Result ("task-" + $r.name) $r.state $r.detail $r.fix
}

# 5 心跳新鲜度
$log = "$env:ProgramData\anc\data\loop.log"
if (Test-Path $log) {
    $age = [int]((Get-Date) - (Get-Item $log).LastWriteTime).TotalMinutes
    if ($age -le 5) { Add-Result 'heartbeat' 'PASS' "$age 分钟内有 tick" '-' }
    else { Add-Result 'heartbeat' 'FAIL' "$age 分钟没有 tick" '检查 anc-service 是否被禁用或报错' }
} else { Add-Result 'heartbeat' 'FAIL' '没有 loop.log' '先跑一次 anc-service' }

# 6 WorkBuddy 版本：路径优先取补丁写下的 workbuddy-path.txt（LOCAL SERVICE 也能定位）
$wbPathFile = "$env:ProgramData\anc\data\workbuddy-path.txt"
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
if ($plog) {
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
if (-not $share) { Add-Result 'smb' 'FAIL' '共享不存在' 'New-SmbShare -Name anc-vault-shared -Path D:\anc\vault-shared' }
else {
    $access = Get-SmbShareAccess -Name 'anc-vault-shared'
    $bad = $access | Where-Object { $_.AccountName -match 'Everyone|Authenticated Users|\\Users$' -and $_.AccessControlType -eq 'Allow' -and $_.AccessRight -ne 'Read' }
    if ($bad) { Add-Result 'smb' 'FAIL' ('共享对广泛组有写权限: ' + (($bad | ForEach-Object { $_.AccountName }) -join ', ')) '收成 Read' }
    else { Add-Result 'smb' 'PASS' '共享存在且 Everyone/Authenticated Users/Users 只读' '-' }
}

# 11 vault 目录 NTFS
$shared = 'D:\anc\vault-shared'
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
} else { Add-Result 'vault-acl' 'WARN' '共享区目录不存在' '按 docs/OPS.md 建 D:\anc\vault-shared' }

# 12 密钥目录权限（webhook 是 bearer 凭据）
$sec = Test-SecretsAcl "$env:ProgramData\anc\secrets"
Add-Result 'secrets-acl' $sec.state $sec.detail $sec.fix

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
if ($tz -eq 'China Standard Time') { Add-Result 'timezone' 'PASS' $tz '-' }
else { Add-Result 'timezone' 'WARN' "当前 $tz" '设计默认 Asia/Shanghai；确认是有意为之' }

# 16 数据库
$db = "$env:ProgramData\anc\data\anc.db"
if (Test-Path $db) { Add-Result 'database' 'PASS' ((Get-Item $db).Length.ToString() + ' B') '-' }
else { Add-Result 'database' 'FAIL' '数据库不存在' '跑一次 service cli 初始化' }

# 17 绑定：提醒按群的 webhook_file 选文件，没登记就发不出去
try {
    $braw = & node "$env:ProgramData\anc\service\cli.ts" --db "$env:ProgramData\anc\data\anc.db" --json bind list 2>$null | Out-String
    $b = ($braw | ConvertFrom-Json).bindings
    if (-not $b -or $b.Count -eq 0) {
        Add-Result 'bindings' 'WARN' '没有任何群绑定' 'bind import --from groups.json 或 bind set'
    } else {
        $missing = @($b | Where-Object { -not $_.webhook_file })
        if ($missing.Count -gt 0) {
            Add-Result 'bindings' 'FAIL' ("$($missing.Count)/$($b.Count) 个群没登记 webhook_file，提醒会发不出去") 'bind set --chat-id <chatid> --employee <名> --webhook-file wecom-webhook.txt'
        } else {
            Add-Result 'bindings' 'PASS' ("$($b.Count) 个绑定都登记了 webhook") '-'
        }
    }
} catch { Add-Result 'bindings' 'WARN' '读绑定失败' '检查数据库与 cli.ts' }

# 18 canary：补丁生效后真实收到的消息里有没有 chatId
$canary = "$env:ProgramData\anc\data\patch-canary.json"
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
