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
function Get-Sha([string]$p) { if (Test-Path $p) { (Get-FileHash $p -Algorithm SHA256).Hash.ToLower() } else { $null } }

# 1 专用用户
$bot = Get-LocalUser -Name 'anc-bot' -ErrorAction SilentlyContinue
if (-not $bot) {
    Add-Result 'dedicated-user' 'FAIL' '没有 anc-bot 用户' '跑 scripts\provision 或在 OPS.md 里建；上线前必须'
} elseif (Get-LocalGroupMember -Group Administrators | Where-Object { $_.Name -match 'anc-bot' }) {
    Add-Result 'dedicated-user' 'FAIL' 'anc-bot 在管理员组' '移出管理员组'
} else {
    Add-Result 'dedicated-user' 'PASS' 'anc-bot 存在且非管理员' '-'
}

# 2 工作时段与配置
$start = $null; $end = $null
try {
    $cfgRaw = & node "$env:ProgramData\anc\service\cli.ts" --db "$env:ProgramData\anc\data\anc.db" --json config list 2>$null | Out-String
    $cfg = $cfgRaw | ConvertFrom-Json
    $start = $cfg.config.work_start; $end = $cfg.config.work_end
} catch { }
if ($start -and $end) { Add-Result 'work-hours' 'PASS' "$start–$end" '-' } else { Add-Result 'work-hours' 'WARN' '未配置工作时段（默认全天）' '需要时 config set work_start/work_end' }

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
    $patched = [bool]($last | Select-String -Pattern 'PATCHED' -Quiet)
    $anchor = [bool]($last | Select-String -Pattern 'ANCHOR-PATCH' -Quiet)
    $hook = [bool]($last | Select-String -Pattern 'update-hook installed' -Quiet)
    if ($patched -and $hook) { Add-Result 'patch' 'PASS' 'PATCHED + update-hook' '-' }
    elseif ($anchor -and $hook) { Add-Result 'patch' 'WARN' '锚点模式（版本未登记）' '按 docs/WORKBUDDY-PATCH.md 回归后更新 manifest 的 version/sha256' }
    else { Add-Result 'patch' 'FAIL' '日志里缺 PATCHED/ANCHOR 或 update-hook' '重启补丁启动器，看 workbuddy-patch.log' }
} else { Add-Result 'patch' 'WARN' '没有补丁日志（可能未用启动器）' '用 launch-patched.ps1 启动' }

# 7 SMB 与 NTFS
$share = Get-SmbShare -Name 'anc-vault-shared' -ErrorAction SilentlyContinue
if (-not $share) { Add-Result 'smb' 'FAIL' '共享不存在' 'New-SmbShare -Name anc-vault-shared -Path D:\anc\vault-shared' }
else {
    $access = Get-SmbShareAccess -Name 'anc-vault-shared'
    $bad = $access | Where-Object { $_.AccountName -match 'Everyone' -and $_.AccessRight -ne 'Read' }
    if ($bad) { Add-Result 'smb' 'FAIL' 'Everyone 有写权限' '收掉 Everyone 写权限' }
    else { Add-Result 'smb' 'PASS' '共享存在且无 Everyone 写' '-' }
}
$shared = 'D:\anc\vault-shared'
if (Test-Path $shared) {
    $users = (Get-Acl $shared).Access | Where-Object { $_.IdentityReference -match 'Users' -and $_.FileSystemRights -match 'Modify|Write' -and $_.AccessControlType -eq 'Allow' }
    if ($users) { Add-Result 'vault-acl' 'FAIL' '共享区 Users 有写权限' 'icacls 收成 ReadAndExecute' }
    else { Add-Result 'vault-acl' 'PASS' '共享区 Users 只读' '-' }
} else { Add-Result 'vault-acl' 'WARN' '共享区目录不存在' '按 docs/OPS.md 建 D:\anc\vault-shared' }

# 8 密钥不进 git（看内容里的真实形态，不看文件名）
if (Test-Path (Join-Path $Repo '.git')) {
    $hits = & git -C $Repo grep -I -n -E 'qyapi\.weixin\.qq\.com/cgi-bin/webhook/send\?key=[A-Za-z0-9-]{8,}|corpsecret[[:space:]]*=[[:space:]]*[A-Za-z0-9]{8,}' -- ':!*.test.ts' ':!*.test.mjs' ':!docs/*' 2>$null
    if ($hits) { Add-Result 'secrets-in-git' 'FAIL' ('仓库内容里有疑似密钥: ' + (($hits | Select-Object -First 2) -join ' | ')) '删掉并改用占位符；密钥只放 ProgramData' }
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
