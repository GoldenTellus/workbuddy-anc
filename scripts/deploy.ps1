# 部署：把仓库里的运行件复制到 %ProgramData%\anc\
# 原则（OPS.md「补丁的唯一来源」）：线上只从部署目录跑，不从 git 工作副本跑。
# 默认 dry-run；加 -Apply 才落盘。落盘前备份、落盘后逐文件对拍 hash，失败回滚。
# 退出码：0 成功（含 dry-run）/ 1 校验失败且已回滚 / 2 用法或环境错误 / 3 已应用但探针失败且已回滚
[CmdletBinding()]
param(
    [string]$Repo = 'E:\workbuddy-anc',
    [string]$Root = '',
    [switch]$Apply
)

$ErrorActionPreference = 'Stop'
if (-not $Root) { $Root = Join-Path $env:ProgramData 'anc' }

function Fail([string]$msg, [string]$fix, [int]$code) {
    Write-Host "ERROR $msg"
    Write-Host "FIX   $fix"
    exit $code
}

if (-not (Test-Path (Join-Path $Repo '.git'))) { Fail "不是仓库根: $Repo" '用 -Repo 指向仓库根（含 .git 的目录）' 2 }
if (-not (Test-Path $Root)) { Fail "部署根不存在: $Root" '先按 REBUILD.md 建 %ProgramData%\anc 及各子目录' 2 }

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
    Fail ('复制失败: ' + $_.Exception.Message) ('已写入的文件会回滚；备份在 ' + $bakRoot) 3
}

# 逐文件对拍
$bad = @()
foreach ($p in $plan) {
    if (-not (Test-Path $p.Dst)) { $bad += ($p.Dst + '（缺失）'); continue }
    if ((Get-FileHash $p.Dst -Algorithm SHA256).Hash -ne $p.Hash) { $bad += ($p.Dst + '（hash 不一致）') }
}

if ($bad.Count -gt 0) {
    foreach ($p in $plan) {
        $b = Join-Path (Join-Path $bakRoot $p.Target) (Split-Path $p.Dst -Leaf)
        if (Test-Path $b) { Copy-Item -LiteralPath $b -Destination $p.Dst -Force -ErrorAction SilentlyContinue }
        else { Remove-Item -LiteralPath $p.Dst -Force -ErrorAction SilentlyContinue }
    }
    foreach ($d in $createdDirs) { Remove-Item -LiteralPath $d -Force -Recurse -ErrorAction SilentlyContinue }
    Fail ('落盘后校验失败: ' + ($bad -join '; ')) ('已回滚；备份在 ' + $bakRoot) 1
}

'OK：{0} 个文件已部署并逐一校验通过。备份: {1}' -f $plan.Count, $bakRoot
'提示：跑一次 scripts\doctor.ps1（部署目录里的那份），deploy-layout 应转 PASS。'
exit 0
