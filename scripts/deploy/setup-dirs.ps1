# 建部署目录与 vault 目录（公司侧 §4）。
#
# 为什么单独一个脚本：
#   手册里是 20 个 `New-Item` 拼两行 ForEach，抄错一个名字要到运行时才发现
#   （典型症状：ingest 报「找不到 inbox」、备份报「没有 backup 目录」）。
#   deploy.ps1 只建它自己要写的 7 个，其余是运行时才落盘的。
#
# 幂等：已存在就跳过，不报错。
#
# 用法：
#   setup-dirs.ps1 -VaultRoot D:\anc            # 预演
#   setup-dirs.ps1 -VaultRoot D:\anc -Apply     # 落盘（要管理员，写 ProgramData）
#
# 退出码：0 成功 / 1 校验失败 / 2 用法

[CmdletBinding()]
param(
    [string]$Root = '',
    [string]$VaultRoot = 'D:\anc',
    [switch]$Apply,
    [switch]$Json
)

$ErrorActionPreference = 'Stop'
if (-not $Root) { $Root = Join-Path $env:ProgramData 'anc' }

# 15 个部署目录。哪些真正被写：
#   bin/tools/patch/service/core/... 由 deploy.ps1 写；data/secrets/backup 由运行时写；
#   evals/stage/inbox/ingest/render/light/skills/accounts 由具体功能写。
$deployDirs = @(
    'accounts', 'backup', 'bin', 'data', 'evals', 'inbox', 'ingest',
    'light', 'patch', 'render', 'secrets', 'service', 'shared', 'skills', 'stage'
)
# 5 个 vault 目录。inbox 是入库落地区，build 放构建产物，org 是组织数据。
$vaultDirs = @('vault-shared', 'vault-internal', 'inbox', 'org', 'build')

$created = @(); $existed = @()

$isAdmin = $false
try {
    $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
} catch { }
if ($Apply -and -not $isAdmin) {
    if ($Json) { [pscustomobject]@{ ok = $false; error = '要管理员权限写 %ProgramData%'; next = '用管理员打开 WorkBuddy 再跑' } | ConvertTo-Json }
    else { Write-Output 'ERROR 要管理员权限写 %ProgramData%'; Write-Output 'FIX   用管理员打开 WorkBuddy 再跑（preflight 的 agent-elevated 就是拦这个）' }
    exit 2
}

foreach ($d in $deployDirs) {
    $p = Join-Path $Root $d
    if (Test-Path $p) { $existed += ('root\' + $d); continue }
    if ($Apply) { New-Item -ItemType Directory -Path $p -Force | Out-Null }
    $created += ('root\' + $d)
}
foreach ($d in $vaultDirs) {
    $p = Join-Path $VaultRoot $d
    if (Test-Path $p) { $existed += ('vault\' + $d); continue }
    if ($Apply) { New-Item -ItemType Directory -Path $p -Force | Out-Null }
    $created += ('vault\' + $d)
}

# 校验：落盘后必须真的都在
$missing = @()
if ($Apply) {
    foreach ($d in $deployDirs) { if (-not (Test-Path (Join-Path $Root $d))) { $missing += ('root\' + $d) } }
    foreach ($d in $vaultDirs) { if (-not (Test-Path (Join-Path $VaultRoot $d))) { $missing += ('vault\' + $d) } }
}

$ok = ($missing.Count -eq 0)
$next = if (-not $Apply) { '预演完成。加 -Apply 落盘。' }
        elseif ($missing.Count -gt 0) { '有目录没建成，看 missing；多半是权限或盘满。' }
        else { '目录就绪。接着 files（deploy.ps1 -Apply）。' }

if ($Json) {
    try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
    [pscustomobject]@{
        ok      = $ok
        root    = $Root
        vault   = $VaultRoot
        created = @($created)
        existed = @($existed)
        missing = @($missing)
        next    = $next
    } | ConvertTo-Json -Depth 5
} else {
    Write-Output ('部署目录 ' + $deployDirs.Count + ' 个 / vault 目录 ' + $vaultDirs.Count + ' 个')
    Write-Output ('新建 ' + $created.Count + '，已存在 ' + $existed.Count)
    foreach ($m in $missing) { Write-Output ('MISSING ' + $m) }
    Write-Output ''
    Write-Output ('NEXT  ' + $next)
}
exit $(if ($ok) { 0 } else { 1 })
