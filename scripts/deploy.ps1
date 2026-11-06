# 部署：把仓库里的运行件复制到 %ProgramData%\anc\
# 原则（OPS.md「补丁的唯一来源」）：线上只从部署目录跑，不从 git 工作副本跑。
# 默认 dry-run；加 -Apply 才落盘。落盘前备份、落盘后逐文件对拍 hash，失败回滚。
# 退出码：0 成功（含 dry-run）/ 1 落盘后校验失败且已回滚 / 2 用法或环境错误 / 3 复制失败且已回滚
[CmdletBinding()]
param(
    [string]$Repo = 'E:\workbuddy-anc',

    # 哪一侧：决定部署根。和 preflight / deploy-state / deploy-verify 保持一致。
    #   company  → %ProgramData%\anc（要注册任务、写 ProgramData，需管理员）
    #   employee → %LOCALAPPDATA%\anc（个人电脑上不该有 ProgramData 级别的写入）
    # 2026-11-05 加：原来只有 -Root，agent 读文档时得自己拼路径，容易错。
    [ValidateSet('company', 'employee')]
    [string]$Side = 'company',

    [string]$Root = '',
    [switch]$Apply
)

$ErrorActionPreference = 'Stop'
if (-not $Root) {
    $Root = if ($Side -eq 'company') { Join-Path $env:ProgramData 'anc' } else { Join-Path $env:LOCALAPPDATA 'anc' }
}

function Fail([string]$msg, [string]$fix, [int]$code) {
    Write-Host "ERROR $msg"
    Write-Host "FIX   $fix"
    exit $code
}

if (-not (Test-Path (Join-Path $Repo '.git'))) { Fail "不是仓库根: $Repo" '用 -Repo 指向仓库根（含 .git 的目录）' 2 }
if (-not (Test-Path $Root)) {
    # FIX 文案按侧分：员工侧不该被指向 %ProgramData%
    $fixDir = if ($Side -eq 'company') {
        '先建 %ProgramData%\anc 及各子目录（REBUILD §1 / AGENT-DEPLOY-COMPANY §4）'
    } else {
        '先建 ' + $Root + ' 及各子目录（AGENT-DEPLOY-EMPLOYEE §4 有命令）'
    }
    Fail "部署根不存在: $Root" $fixDir 2
}

# 目标子目录 ← 源；bin 只取 scripts 顶层（不含 workbuddy-patch / verify 子目录）
$Map = @(
    @{ Target = 'service'; Source = 'src\service'; Filter = @('*.ts', '*.json'); Exclude = @('*.test.ts') },
    @{ Target = 'ingest';  Source = 'src\ingest';  Filter = @('*.ts', '*.json'); Exclude = @('*.test.ts') },
    @{ Target = 'render';  Source = 'src\render';  Filter = @('*.ts', '*.json'); Exclude = @('*.test.ts') },
    @{ Target = 'light\templates'; Source = 'light\templates'; Filter = @('*.md'); Exclude = @() },
    @{ Target = 'shared';  Source = 'src\shared';  Filter = @('*.ts', '*.json'); Exclude = @('*.test.ts') },
    @{ Target = 'bin';     Source = 'scripts';     Filter = @('*.ps1', '*.cmd', '*.vbs'); Exclude = @() },
    @{ Target = 'patch';   Source = 'scripts\workbuddy-patch'; Filter = @('*'); Exclude = @() }
)

# 覆盖检查：src 下每个非测试 .ts 都必须能落到某个映射里。
# 2026-11-02 踩过：加了 src/audit.ts 但映射没跟上，部署后 cli 直接 ERR_MODULE_NOT_FOUND，doctor 全瞎。
$srcRoot = Join-Path $Repo 'src'
if (Test-Path $srcRoot) {
    $sources = @($Map | ForEach-Object { (Join-Path $Repo $_.Source).TrimEnd('\') })
    $uncovered = @()
    foreach ($f in @(Get-ChildItem $srcRoot -Recurse -File -Filter '*.ts' | Where-Object { $_.Name -notmatch '\.test\.ts$' })) {
        $ok = $false
        foreach ($s2 in $sources) { if ($f.FullName.StartsWith($s2 + '\')) { $ok = $true; break } }
        if (-not $ok) { $uncovered += $f.FullName.Substring($Repo.Length + 1) }
    }
    if ($uncovered.Count -gt 0) {
        Fail ('这些源文件没有部署目标: ' + ($uncovered -join ', ')) '在 deploy.ps1 的 $Map 里给它加一条，否则线上会 import 失败' 2
    }
}
$plan = @()
foreach ($m in $Map) {
    $srcDir = Join-Path $Repo $m.Source
    if (-not (Test-Path $srcDir)) { Fail "源目录不存在: $srcDir" '确认 -Repo 指向仓库根' 2 }
    foreach ($f in @(Get-ChildItem -LiteralPath $srcDir -File)) {
        $n = $f.Name
        $hit = $false
        foreach ($p in $m.Filter) { if ($n -like $p) { $hit = $true; break } }
        if (-not $hit) { continue }
        $skip = $false
        foreach ($p in $m.Exclude) { if ($n -like $p) { $skip = $true; break } }
        if ($skip) { continue }
        $plan += [pscustomobject]@{
            Target = $m.Target
            Src    = $f.FullName
            Dst    = Join-Path (Join-Path $Root $m.Target) $n
            Hash   = (Get-FileHash $f.FullName -Algorithm SHA256).Hash
            Bytes  = $f.Length
        }
    }
}
if ($plan.Count -eq 0) { Fail '没有可部署的文件' '检查 -Repo 与源目录' 2 }

# 计划摘要（两种模式都先打印）
$grouped = $plan | Group-Object Target
foreach ($g in $grouped) {
    '{0,-9} {1,3} 个文件  {2,9:N0} B' -f $g.Name, $g.Count, (($g.Group | Measure-Object Bytes -Sum).Sum)
}
'合计 {0} 个文件，目标根 {1}' -f $plan.Count, $Root
''

if (-not $Apply) {
    'DRY-RUN：以上是计划，加 -Apply 才落盘。'
    exit 0
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$bakRoot = Join-Path (Join-Path $Root 'backup') ('deploy-' + $stamp)
$createdDirs = @()
$copied = @()

function Copy-WithRetry([string]$Src, [string]$Dst, [int]$Tries = 3) {
    for ($i = 1; $i -le $Tries; $i++) {

        try {
            Copy-Item -LiteralPath $Src -Destination $Dst -Force -ErrorAction Stop
            return
        } catch {
            if ($i -eq $Tries) { throw }
            Start-Sleep -Milliseconds 250
        }
    }
}

# 回滚：把 $Items 里每个目标恢复到备份、删掉没有备份的新文件，并清掉本次新建的目录。
# 2026-11-06 修：原来只有「落盘后 hash 校验失败」会回滚，复制中途抛错直接 exit 3，
# 前半套新文件已经盖在旧文件上，错误文案却说「已写入的文件会回滚」——是假的。
function Restore-Deploy([object[]]$Items, [string]$BackupRoot) {
    # 2026-11-06 二修：回滚是最后一道安全底线，原来每步都 -ErrorAction SilentlyContinue
    # 且不查 $? —— 文件被占用 / ACL 拒绝 / 盘满时静默跳过，脚本照样打印「已回滚」。
    $failed = @()
    foreach ($p in $Items) {
        $b = Join-Path (Join-Path $BackupRoot $p.Target) (Split-Path $p.Dst -Leaf)
        try {
            if (Test-Path -LiteralPath $b) {
                Copy-Item -LiteralPath $b -Destination $p.Dst -Force -ErrorAction Stop
            } elseif (Test-Path -LiteralPath $p.Dst) {
                Remove-Item -LiteralPath $p.Dst -Force -ErrorAction Stop
            }
        } catch { $failed += ($p.Dst + '：' + $_.Exception.Message) }
    }
    foreach ($d in $createdDirs) {
        try { Remove-Item -LiteralPath $d -Force -Recurse -ErrorAction Stop }
        catch { $failed += ($d + '：' + $_.Exception.Message) }
    }
    return ,$failed
}

# 权限：secrets 与 data 的 ACL 不随文件复制走，单独设（2026-11-05，VERIFY §65/§66/§70）。
# 必须在 Copy-WithRetry 定义**之外** —— 2026-11-05 曾误插进那个 for 循环里，
# 结果每次重试都调一次 set-acl，73 个文件 × 3 次重试 = 219 次 × 7 秒，deploy 变成 25 分钟。
# 员工侧没有 LOCAL SERVICE 任务，set-acl.ps1 自己会整段跳过。
$setAclPs1 = Join-Path $PSScriptRoot 'set-acl.ps1'
if (Test-Path $setAclPs1) {
    $aclArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $setAclPs1, '-Root', $Root, '-Side', $Side)
    if ($Apply) { $aclArgs += '-Apply' }
    # 必须跳过自检 —— 三层嵌套（deploy → set-acl → doctor）会卡死（VERIFY §70）。
    $aclArgs += '-SkipVerify'
    & powershell @aclArgs
    if ($LASTEXITCODE -ne 0 -and $Apply) {
        Fail ('设 ACL 失败（exit ' + $LASTEXITCODE + '）') '看上面 set-acl.ps1 的 ERR 行；可能需要管理员权限' 2
    }
} else {
    '注意：没找到 scripts\set-acl.ps1 —— secrets / data 的 ACL 要人工设（见 REBUILD §2.5）'
}

try {
    foreach ($p in $plan) {
        $dstDir = Split-Path $p.Dst -Parent
        if (-not (Test-Path $dstDir)) {
            New-Item -ItemType Directory -Path $dstDir -Force | Out-Null
            $createdDirs += $dstDir
        }
        if (Test-Path $p.Dst) {
            $bak = Join-Path (Join-Path $bakRoot $p.Target) (Split-Path $p.Dst -Leaf)
            $bakDir = Split-Path $bak -Parent
            if (-not (Test-Path $bakDir)) { New-Item -ItemType Directory -Path $bakDir -Force | Out-Null }
            Copy-Item -LiteralPath $p.Dst -Destination $bak -Force
        }
        Copy-WithRetry $p.Src $p.Dst
        $copied += $p
    }
} catch {
    # 只回滚真正复制过的 $copied：没处理到的目标若走「无备份就删除」，会误删原文件
    $rb = @(Restore-Deploy $copied $bakRoot)
    if ($rb.Count -gt 0) {
        Fail ('复制失败: ' + $_.Exception.Message) ('回滚不完整（' + $rb.Count + ' 项失败）：' + ($rb -join '; ') + '；需手工从 ' + $bakRoot + ' 恢复') 3
    }
    Fail ('复制失败: ' + $_.Exception.Message) ('已回滚 ' + $copied.Count + ' 个已写入文件；备份在 ' + $bakRoot) 3
}

# 逐文件对拍
$bad = @()
foreach ($p in $plan) {
    if (-not (Test-Path $p.Dst)) { $bad += ($p.Dst + '（缺失）'); continue }
    if ((Get-FileHash $p.Dst -Algorithm SHA256).Hash -ne $p.Hash) { $bad += ($p.Dst + '（hash 不一致）') }
}

if ($bad.Count -gt 0) {
    $rb = @(Restore-Deploy $plan $bakRoot)
    if ($rb.Count -gt 0) {
        Fail ('落盘后校验失败: ' + ($bad -join '; ')) ('回滚不完整（' + $rb.Count + ' 项失败）：' + ($rb -join '; ') + '；需手工从 ' + $bakRoot + ' 恢复') 1
    }
    Fail ('落盘后校验失败: ' + ($bad -join '; ')) ('已回滚；备份在 ' + $bakRoot) 1
}

'OK：{0} 个文件已部署并逐一校验通过。备份: {1}' -f $plan.Count, $bakRoot
'提示：跑一次 scripts\doctor.ps1（部署目录里的那份），deploy-layout 应转 PASS。'
exit 0
