# 部署进度状态 —— 薄壳（行为全在 deploy-state.mjs）
#
# 为什么只剩壳：
#   记账逻辑原来在 248 行 PowerShell 里（两个 PS 语义坑、UTF-8 输出坑都踩过）。
#   为了让 macOS / CI / Windows 跑同一份行为，逻辑搬进零依赖的 deploy-state.mjs；
#   本文件只保留**参数契约**（-Side/-Root/-Mark/-AsDone/-AsFailed/-Reason/-Status/-Next/-Reset/-Apply/-Json），
#   原样转调 node。调用方（install-company.ps1、setup-executor.ps1、agent 命令行）一个字都不用改。
#
# 与 mjs 的关系：
#   - 行为源：scripts/deploy/deploy-state.mjs（JSON 契约、company 14 / employee 9 阶段、退出码 0/1/2）
#   - 本文件不判断业务、不写状态文件；只做参数转发 + node 定位 + UTF-8 输出编码
#   - 退出码直接透传 mjs 的退出码（0 正常 / 1 有 failed 未处理 / 2 用法错误）
#
# 部署布局注意：
#   deploy.ps1 把本脚本拷到 <root>\tools\ 或 <root>\bin\；mjs 必须和它同目录
#   （$PSScriptRoot\deploy-state.mjs）。从仓库直接跑时用 $env:ANC_REPO 指仓库根，或保持 scripts\deploy 相对布局。
#
# 用法（与旧版一致）：
#   deploy-state.ps1 -Side company -Status -Json
#   deploy-state.ps1 -Side company -Mark dirs -AsDone -Json
#   deploy-state.ps1 -Side company -Mark patch -AsFailed -Reason "ANCHOR-MISS" -Json
#   deploy-state.ps1 -Side company -Next -Json
#   deploy-state.ps1 -Side company -Reset -Apply
#
# 退出码：0 正常（含"全部完成"）/ 1 有 failed 未处理 / 2 用法错误（含找不到 node / mjs）

param(
    [ValidateSet('company', 'employee')]
    [string]$Side = 'company',

    [string]$Root = '',

    [switch]$Status,
    [switch]$Next,
    [switch]$Reset,
    [switch]$Apply,

    [string]$Mark = '',
    [switch]$AsDone,
    [switch]$AsFailed,
    [string]$Reason = '',

    [switch]$Json
)

$ErrorActionPreference = 'Stop'

# node 写的是 UTF-8 字节；PS 5.1 在重定向/管道场景会按 [Console]::OutputEncoding（默认 GBK）解码，
# 中文 reason / next 会变 mojibake（2026-11-05 全量测试有 3 条因此红）。先切编码再调。
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

# ── 定位 mjs ────────────────────────────────────────────────
$candidates = @()
if ($env:ANC_REPO) { $candidates += (Join-Path $env:ANC_REPO 'scripts\deploy\deploy-state.mjs') }
$candidates += (Join-Path $PSScriptRoot 'deploy-state.mjs')
$candidates += (Join-Path $PSScriptRoot '..\..\scripts\deploy\deploy-state.mjs')
$mjs = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $mjs) {
    Write-Host ("ERROR 找不到 deploy-state.mjs（找过: {0}）" -f ($candidates -join '; '))
    exit 2
}

# ── 定位 node ──────────────────────────────────────────────
$nodeExe = $env:ANC_NODE
if (-not $nodeExe) {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { $nodeExe = $cmd.Source }
}
if (-not $nodeExe) { $nodeExe = Join-Path $env:ProgramFiles 'nodejs\node.exe' }
if (-not (Test-Path -LiteralPath $nodeExe)) {
    Write-Host 'ERROR 找不到 node（装 Node 22，或用 $env:ANC_NODE 指定路径）'
    exit 2
}

# ── 原参数 → mjs 参数（名字保持旧用法，值原样转发）──────────
$argv = @('--side', $Side)
if ($Root) { $argv += @('--root', $Root) }
if ($Status) { $argv += '--status' }
if ($Next) { $argv += '--next' }
if ($Reset) { $argv += '--reset' }
if ($Apply) { $argv += '--apply' }
if ($Mark) { $argv += @('--mark', $Mark) }
if ($AsDone) { $argv += '--as-done' }
if ($AsFailed) { $argv += '--as-failed' }
if ($Reason) { $argv += @('--reason', $Reason) }
if ($Json) { $argv += '--json' }

& $nodeExe $mjs @argv
exit $LASTEXITCODE
