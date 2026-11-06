# 设 %ProgramData%\anc 下 secrets 与 data 的 ACL。
#
# 为什么需要：deploy.ps1 只复制文件、不管权限，而且它**不创建** secrets / data
#   （建这两个目录的是 rebuild-z.ps1）。原来这两个目录的权限是人工敲的，
#   清空重装后会全部丢失（VERIFY §65）。对应 doctor.ps1 的 secrets-acl / data-acl 两项。
#
# 三条硬约束（2026-11-05 由只读审计查明，不是猜的）：
#
#   ① 全程 /grant:r，**不用 /grant**。
#      icacls /grant 是线性追加 ACE —— 重复执行会累积重复项。这台机器上已经出现了：
#      loop.log / http.log / selfheal.log / audit.log 各有 2 条 LOCAL SERVICE:Modify
#      （一条显式、一条继承），就是「先文件 grant、后目录 grant」留下的痕迹。
#
#   ② data **不能用 /inheritance:r**。
#      data 现在是「继承 + 一条显式 LOCAL SERVICE」。断掉继承再只授 LOCAL SERVICE，
#      会把 Administrators 和 SYSTEM 一起摘掉 —— 之后管理员只能 takeown 抢回来。
#      所以 data 只做「加一条显式」，secrets 才断继承。
#
#   ③ 服务身份是 LOCAL SERVICE，不是 SYSTEM。
#      anc-service / anc-http / anc-backup 全部跑在 LOCAL SERVICE 下。
#      判据里若允许 SYSTEM 顶替，删掉 LOCAL SERVICE 时会照样 PASS（VERIFY §63 犯过）。
#
# 自检**不自己写判据**：直接跑 doctor.ps1 的 secrets-acl / data-acl 两项。
#   那两项是双向的（太宽 FAIL、太窄也 FAIL）且刚实测过（VERIFY §63），
#   重写一份只会引入不一致 —— 本脚本第一版的教训就写在自己写判据上。
#
# 用法：
#   powershell -File set-acl.ps1                      # dry-run，只打印要做什么
#   powershell -File set-acl.ps1 -Apply               # 落盘并自检
#   powershell -File set-acl.ps1 -Apply -Side employee  # 员工侧：整段跳过（没有 LOCAL SERVICE 任务）
# 退出码：0 成功（含 dry-run）/ 1 设完自检不过 / 2 用法或环境错误

[CmdletBinding()]
param(
    [string]$Root = (Join-Path $env:ProgramData 'anc'),
    [ValidateSet('company', 'employee')]
    [string]$Side = 'company',
    [string]$Repo = '',
    [switch]$Apply,
    # 2026-11-05 加：跳过 doctor 自检。
    # deploy.ps1 调用时必须传它 —— 否则形成「deploy → set-acl → doctor」三层嵌套，
    # 实测在 deploy.ps1 里会卡死 180 秒不动（VERIFY §70）。完整验证交给部署后的那一次 doctor。
    [switch]$SkipVerify
)

$ErrorActionPreference = 'Stop'

$SVC = 'LOCAL SERVICE'
$SYS = 'SYSTEM'
$ADM = 'Administrators'

# 这 6 个日志是各自独立的 ACL，不继承目录 —— 只设目录不够。
# 漏了它们的症状很阴：anc-loop.cmd 的 >> "%LOGF%" 失败，但计划任务显示「每分钟成功、退出码 0」。
$LOG_FILES = @('loop.log', 'http.log', 'patch-in.log', 'patch-out.log', 'selfheal.log', 'audit.log')

$script:failed = @()

function Say([string]$msg, [string]$level = 'INFO') {
    Write-Host ("[{0}] {1}" -f $level, $msg)
}

function Invoke-Icacls([string]$Command, [string]$What) {
    if (-not $Apply) { Say ("  dry-run: " + $What) 'PLAN'; return }
    # icacls 是原生 exe，不抛异常 —— 必须查 $LASTEXITCODE。
    # 仓库里唯一正确范式是 provision-vault-accounts.ps1:92-93。
    # PS 5.1 在 $ErrorActionPreference='Stop' 下，原生命令写 stderr 会把 `2>&1`
    # 变成终止性 ErrorRecord（RemoteException），根本走不到下面的 $LASTEXITCODE 判断 ——
    # 结果是「icacls 已改了一半、脚本崩了、失败汇总没记」。只在调用期间临时降级。
    $prevPref = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $out = & cmd /c $Command 2>&1 } finally { $ErrorActionPreference = $prevPref }
    if ($LASTEXITCODE -ne 0) {
        Say ("  icacls 失败（exit " + $LASTEXITCODE + "）: " + $What) 'ERR'
        Say ("    " + (($out | Out-String).Trim())) 'ERR'
        $script:failed += $What
        return
    }
    Say ("  ok: " + $What) 'OK'
}

# ── 一、secrets：断继承 + 三方授权 ─────────────────────────────
function Set-SecretsAcl([string]$dir) {
    Say ("secrets: " + $dir)
    # /inheritance:r 只在这里用 —— 这是敏感目录，必须切断上游继承
    #
    # 2026-11-05 修（VERIFY §81.8）：三个主体都必须带 (OI)(CI)。
    # 早先写成 "{1}:F" "{2}:F"（SYSTEM / Administrators 不带继承标志），
    # 结果它们只作用于目录本身、不继承给子项 —— 新建在 secrets 里的文件
    # 只能继承到 LOCAL SERVICE:(OI)(CI)RX 那一条，管理员写不进去。
    # §11 那次部署就卡在这：Copy-Item / icacls / SetAccessControl / takeown /
    # Remove-Item 五种方法全被拒，最后靠一次性 SYSTEM 计划任务重置 DACL 才解决。
    Invoke-Icacls ('icacls "{0}" /inheritance:r /grant:r "{1}:(OI)(CI)F" "{2}:(OI)(CI)F" "{3}:(OI)(CI)RX"' -f $dir, $SYS, $ADM, $SVC) `
        'secrets 目录：断继承，SYSTEM:F + Administrators:F + LOCAL SERVICE:RX'

    # 每个文件是独立 ACL（本机实测：文件的 ACE 都是 Inherited=True，但那是继承自目录之后的状态；
    # 断继承后必须显式给），逐个补。用 :r 保证幂等。
    foreach ($f in @(Get-ChildItem -LiteralPath $dir -File -ErrorAction SilentlyContinue)) {
    # 2026-11-05 修（VERIFY §78.7）：文件级也必须授 SYSTEM:F + Administrators:F。
    # 原来只授 LOCAL SERVICE:(RX) —— 目录做了 /inheritance:r 之后，文件的继承链已经断了，
    # 于是文件上永远没有管理员权限，部署写不进 secrets（换 webhook 只能先手动 icacls 抢）。
    Invoke-Icacls ('icacls "{0}" /grant:r "{1}:F" "{2}:F" "{3}:(RX)"' -f $f.FullName, $SYS, $ADM, $SVC) ('secrets\' + $f.Name + '：SYSTEM:F + Administrators:F + LOCAL SERVICE:RX')
    }
}

# ── 二、data：只加显式，绝不断继承 ────────────────────────────
function Set-DataAcl([string]$dir) {
    Say ("data: " + $dir)
    # 注意：这里**没有** /inheritance:r。见文件头约束 ②。
    Invoke-Icacls ('icacls "{0}" /grant:r "{1}:(OI)(CI)M"' -f $dir, $SVC) 'data 目录：LOCAL SERVICE:(OI)(CI)M'

    foreach ($n in $LOG_FILES) {
        $p = Join-Path $dir $n
        if (-not (Test-Path -LiteralPath $p)) { continue }
        Invoke-Icacls ('icacls "{0}" /grant:r "{1}:(M)"' -f $p, $SVC) ('data\' + $n + '：LOCAL SERVICE:(M)')
    }
}

# ── 三、自检：跑 doctor 的那两项，不自己写判据 ────────────────
function Test-ViaDoctor {
    $doc = Join-Path $Root 'bin\doctor.ps1'
    if (-not (Test-Path -LiteralPath $doc)) {
        Say ("找不到 " + $doc + " —— 先跑 deploy.ps1 把 bin 部署过去") 'ERR'
        return 2
    }
    # -Root 必须传：doctor 默认查 %ProgramData%\anc，自定义演练根时自检会查错一套目录
    $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $doc, '-Json', '-Root', $Root)
    if ($Repo) { $a += @('-Repo', $Repo) }

    Say "自检：跑 doctor.ps1 的 secrets-acl / data-acl（约 17 秒）"
    $raw = & powershell @a 2>&1 | Out-String
    $j = $null
    try { $j = $raw.Substring($raw.IndexOf('{')) | ConvertFrom-Json } catch {
        Say "doctor 输出解析失败 —— 原始输出末 300 字：" 'ERR'
        Say ("  " + $raw.Substring([Math]::Max(0, $raw.Length - 300))) 'ERR'
        return 2
    }

    $bad = 0
    foreach ($name in @('secrets-acl', 'data-acl')) {
        $c = @($j.checks | Where-Object { $_.check -eq $name })
        if ($c.Count -eq 0) { Say ("doctor 里没有 " + $name + " 这一项（版本太旧？）") 'ERR'; $bad++; continue }
        $st = $c[0].state
        if ($st -eq 'PASS') { Say ("  [" + $st + "] " + $name) 'OK' }
        else {
            Say ("  [" + $st + "] " + $name + " —— " + $c[0].detail) 'ERR'
            if ($c[0].fix) { Say ("    fix: " + $c[0].fix) 'ERR' }
            $bad++
        }
    }
    return $(if ($bad -gt 0) { 1 } else { 0 })
}

# ── 主流程 ───────────────────────────────────────────────────────
Say ("root: " + $Root + "   side: " + $Side)
Say ("mode: " + $(if ($Apply) { 'APPLY（会改权限）' } else { 'DRY-RUN（只看）' }))

if ($Side -eq 'employee') {
    # 员工侧没有任何以 LOCAL SERVICE 运行的任务，设这些 ACL 反而可能让员工读写不了自己的数据
    Say "员工侧：没有 LOCAL SERVICE 任务，本脚本整段跳过（exit 0）" 'OK'
    exit 0
}

$secretsDir = Join-Path $Root 'secrets'
$dataDir = Join-Path $Root 'data'
$hasSecrets = Test-Path -LiteralPath $secretsDir
$hasData = Test-Path -LiteralPath $dataDir

if (-not $hasSecrets -and -not $hasData) {
    Say ("$Root 下既没有 secrets 也没有 data —— 还没部署过。") 'ERR'
    Say "  正确顺序：rebuild-z.ps1 建目录 → deploy.ps1 铺文件 → 建 secrets → 再跑本脚本" 'ERR'
    exit 2
}

if ($hasSecrets) { Set-SecretsAcl $secretsDir }
else { Say "secrets 不存在，跳过（建完 secrets 要再跑一次本脚本）" 'WARN' }

if ($hasData) { Set-DataAcl $dataDir }
else { Say "data 不存在，跳过（服务第一次运行会建它，之后要再跑一次本脚本）" 'WARN' }

if ($script:failed.Count -gt 0) {
    foreach ($f in $script:failed) { Say ("icacls 没成功: " + $f) 'ERR' }
    Say "可能是权限不够 —— 本脚本需要以管理员运行" 'ERR'
    exit 1
}

if (-not $Apply) {
    Say "DRY-RUN 结束。加 -Apply 才落盘；落盘后会自动跑 doctor 自检。" 'OK'
    exit 0
}

# APPLY 之后必须自检 —— 「设过了」不等于「设对了」（VERIFY §63 的教训）
Say ""
if ($SkipVerify) {
    Say "跳过 doctor 自检（-SkipVerify）—— 部署完请单独跑一次 doctor.ps1" 'OK'
    exit 0
}
$code = Test-ViaDoctor
if ($code -eq 0) { Say "OK：secrets-acl 与 data-acl 都 PASS" 'OK' }
else { Say "设完了但自检没过 —— 看上面 doctor 的 detail 与 fix" 'ERR' }
exit $code
