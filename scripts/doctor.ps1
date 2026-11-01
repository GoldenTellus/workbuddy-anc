# 主机体检（doctor）：只读检查，每项给 PASS / WARN / FAIL 与出路
# 退出码：0 无 FAIL / 1 有 FAIL / 2 用法错误
[CmdletBinding()]
param(
    [string]$Repo = 'E:\workbuddy-anc',
    [string]$Manifest = '',
    [switch]$Json
)

$ErrorActionPreference = 'Continue'
if (-not $Manifest) { $Manifest = Join-Path $Repo 'scripts\workbuddy-patch\manifest.json' }
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

# 1 专用用户
$bot = Get-LocalUser -Name 'anc-bot' -ErrorAction SilentlyContinue
if (-not $bot) {
    Add-Result 'dedicated-user' 'FAIL' '没有 anc-bot 用户' '跑 scripts\provision 或在 OPS.md 里建；上线前必须'
} elseif (Test-AdminMember 'anc-bot') {
    Add-Result 'dedicated-user' 'FAIL' 'anc-bot 在管理员组（或无法确认）' '移出管理员组；若是查询失败，用 net localgroup Administrators 人工确认'
} else {
    Add-Result 'dedicated-user' 'PASS' 'anc-bot 存在且非管理员' '-'
}

# 2 工作时段与配置
$start = $null; $end = $null
try {
    $cfgRaw = & node "$env:ProgramData\anc\service\cli.ts" --db "$env:ProgramData\anc\data\anc.db" --json config list 2>$null | Out-String
    $cfg = $cfgRaw | ConvertFrom-Json
    $start = $cfg.config.work_start; $end = $cfg.config.work_end
    $cfgProblems = @($cfg.problems)
} catch { $cfgProblems = @() }
if ($cfgProblems.Count -gt 0) { Add-Result 'work-hours' 'FAIL' ('配置有误（已按全天处理）: ' + ($cfgProblems -join '；')) 'config set work_start/work_end 用 HH:mm，且两者不同' }
elseif ($start -and $end) { Add-Result 'work-hours' 'PASS' "$start–$end" '-' } else { Add-Result 'work-hours' 'WARN' '未配置工作时段（默认全天）' '需要时 config set work_start/work_end' }

# 3 计划任务
foreach ($t in 'anc-service', 'anc-backup', 'anc-boot-alert', 'anc-cleanup', 'anc-watchdog') {
    $task = Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue
    if (-not $task) {
        $state = if ($t -eq 'anc-watchdog') { 'WARN' } else { 'FAIL' }
        Add-Result "task-$t" $state '任务不存在' "按 docs/OPS.md 注册 $t"
    } else {
        Add-Result "task-$t" 'PASS' ('状态 ' + $task.State) '-'
    }
}

# 4 心跳新鲜度
$log = "$env:ProgramData\anc\data\loop.log"
if (Test-Path $log) {
    $age = [int]((Get-Date) - (Get-Item $log).LastWriteTime).TotalMinutes
    if ($age -le 5) { Add-Result 'heartbeat' 'PASS' "$age 分钟内有 tick" '-' }
    else { Add-Result 'heartbeat' 'FAIL' "$age 分钟没有 tick" '检查 anc-service 是否被禁用或报错' }
} else { Add-Result 'heartbeat' 'FAIL' '没有 loop.log' '先跑一次 anc-service' }

# 5 WorkBuddy 版本与补丁
$exe = "$env:LOCALAPPDATA\Programs\WorkBuddy\WorkBuddy.exe"
$mf = $null
if (Test-Path $Manifest) {
    try { $mf = Get-Content $Manifest -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $mf = $null }
}
if (Test-Path $Manifest) {
    if (-not $mf) { Add-Result 'manifest' 'FAIL' 'manifest.json 无法解析' '从 git 恢复 scripts/workbuddy-patch/manifest.json' }
    elseif (-not $mf.workbuddyVersion -or -not $mf.sha256) { Add-Result 'manifest' 'FAIL' '缺少 workbuddyVersion / sha256' '从 git 恢复 manifest.json' }
    else { Add-Result 'manifest' 'PASS' ($mf.workbuddyVersion + ' / ' + $mf.sha256.Substring(0, 8) + '…') '-' }
} else { Add-Result 'manifest' 'FAIL' 'manifest.json 不存在' '从 git 恢复' }
if (-not (Test-Path $exe)) { Add-Result 'workbuddy' 'WARN' '当前用户下没装 WorkBuddy' 'bot 用户安装后复测' }
elseif ($mf -and (Get-Item $exe).VersionInfo.FileVersion -ne $mf.workbuddyVersion) {
    Add-Result 'workbuddy' 'FAIL' ("版本 " + (Get-Item $exe).VersionInfo.FileVersion + " != 登记 " + $mf.workbuddyVersion) '按 WORKBUDDY-PATCH.md 重放补丁并更新 manifest'
} else { Add-Result 'workbuddy' 'PASS' ('版本 ' + (Get-Item $exe).VersionInfo.FileVersion) '-' }

# 6 补丁日志
$plog = "$env:USERPROFILE\anc\workbuddy-patch.log"
if (Test-Path $plog) {
    $last = Get-Content $plog -Tail 200
    # 只看最近一次 APPLIED / ANCHOR-MISS：APPLIED 由补丁体在包装成功后写，旧的 PATCHED 行不再算
    $lastApply = $last | Select-String -Pattern 'APPLIED mode=|ANCHOR-MISS' | Select-Object -Last 1
    $hook = [bool]($last | Select-String -Pattern 'update-hook installed' -Quiet)
    if ($lastApply -and $lastApply.Line -match 'APPLIED mode=hash' -and $hook) { Add-Result 'patch' 'PASS' 'APPLIED(hash) + update-hook' '-' }
    elseif ($lastApply -and $lastApply.Line -match 'APPLIED mode=anchor' -and $hook) { Add-Result 'patch' 'WARN' '锚点模式（版本未登记）' '按 docs/WORKBUDDY-PATCH.md 回归后更新 manifest 的 version/sha256' }
    elseif ($lastApply -and $lastApply.Line -match 'ANCHOR-MISS') { Add-Result 'patch' 'FAIL' '补丁已注入但没找到 emitMessage' '按 light/skills/anc-wb-patch 重找注入点' }
    else { Add-Result 'patch' 'FAIL' '日志里缺 APPLIED 或 update-hook' '重启补丁启动器，看 workbuddy-patch.log' }
} else { Add-Result 'patch' 'WARN' '没有补丁日志（可能未用启动器）' '用 launch-patched.ps1 启动' }

# 7 SMB 与 NTFS
$share = Get-SmbShare -Name 'anc-vault-shared' -ErrorAction SilentlyContinue
if (-not $share) { Add-Result 'smb' 'FAIL' '共享不存在' 'New-SmbShare -Name anc-vault-shared -Path D:\anc\vault-shared' }
else {
    $access = Get-SmbShareAccess -Name 'anc-vault-shared'
    $bad = $access | Where-Object { $_.AccountName -match 'Everyone|Authenticated Users|\\Users$' -and $_.AccessControlType -eq 'Allow' -and $_.AccessRight -ne 'Read' }
    if ($bad) { Add-Result 'smb' 'FAIL' ('共享对广泛组有写权限: ' + (($bad | ForEach-Object { $_.AccountName }) -join ', ')) '收成 Read' }
    else { Add-Result 'smb' 'PASS' '共享存在且 Everyone/Authenticated Users/Users 只读' '-' }
}
$shared = 'D:\anc\vault-shared'
if (Test-Path $shared) {
    # 按权限位判定：FullControl / GENERIC_ALL 这类不含「Write」字样，按字符串匹配会漏判
    $writeBits = [int]([Security.AccessControl.FileSystemRights]::WriteData -bor [Security.AccessControl.FileSystemRights]::AppendData -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership)
    $genericWrite = 0x40000000 -bor 0x10000000   # GENERIC_WRITE | GENERIC_ALL
    $broad = 'Users$|Everyone$|Authenticated Users$|^S-1-5-32-545$|^S-1-1-0$|^S-1-5-11$'
    $users = (Get-Acl $shared).Access | Where-Object {
        $_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Value -match $broad -and
        ((([int]$_.FileSystemRights) -band $writeBits) -or (([int64]$_.FileSystemRights) -band $genericWrite))
    }
    if ($users) { Add-Result 'vault-acl' 'FAIL' ('共享区对广泛组有写权限: ' + (($users | ForEach-Object { $_.IdentityReference.Value }) -join ', ')) 'icacls 收成 ReadAndExecute' }
    else { Add-Result 'vault-acl' 'PASS' '共享区对 Users/Everyone/Authenticated Users 只读' '-' }
} else { Add-Result 'vault-acl' 'WARN' '共享区目录不存在' '按 docs/OPS.md 建 D:\anc\vault-shared' }

# 8 密钥不进 git（看内容里的真实形态，不看文件名）
if (Test-Path (Join-Path $Repo '.git')) {
    $hits = & git -C $Repo grep -I -n -E 'qyapi\.weixin\.qq\.com/cgi-bin/webhook/send\?key=[A-Za-z0-9-]{8,}|corpsecret[[:space:]]*=[[:space:]]*[A-Za-z0-9]{8,}' -- ':!*.test.ts' ':!*.test.mjs' ':!docs/*' 2>$null
    # 只报位置，不回显命中内容：doctor 的输出可能被 bot 贴进群里
    $where = $hits | Select-Object -First 3 | ForEach-Object { ($_ -split ':', 3)[0..1] -join ':' }
    if ($hits) { Add-Result 'secrets-in-git' 'FAIL' ('仓库内容里有疑似密钥，位置: ' + ($where -join ', ')) '删掉并改用占位符；密钥只放 ProgramData' }
    else { Add-Result 'secrets-in-git' 'PASS' '仓库内容未见真实密钥' '-' }
} else { Add-Result 'secrets-in-git' 'WARN' "不是 git 仓库: $Repo" '传对 -Repo' }

# 9 时区
$tz = (Get-TimeZone).Id
if ($tz -eq 'China Standard Time') { Add-Result 'timezone' 'PASS' $tz '-' }
else { Add-Result 'timezone' 'WARN' "当前 $tz" '设计默认 Asia/Shanghai；确认是有意为之' }

# 10 数据库
$db = "$env:ProgramData\anc\data\anc.db"
if (Test-Path $db) { Add-Result 'database' 'PASS' ((Get-Item $db).Length.ToString() + ' B') '-' }
else { Add-Result 'database' 'FAIL' '数据库不存在' '跑一次 service cli 初始化' }

# 10.5 绑定：提醒按群的 webhook_file 选文件，没登记就发不出去
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

# 11 canary：补丁生效后真实收到的消息里有没有 chatId
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
    foreach ($r in $results) { "{0,-6} {1,-18} {2}" -f $r.state, $r.check, $r.detail }
    ""
    "FAIL=$fails WARN=$warns"
    foreach ($r in $results | Where-Object { $_.state -ne 'PASS' }) { "FIX    " + $r.check + ': ' + $r.fix }
}
if ($fails -gt 0) { exit 1 } else { exit 0 }
