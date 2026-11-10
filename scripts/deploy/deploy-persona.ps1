# 部署公司 bot 的 CODEBUDDY.md（M1 第一版）
# - 源文件：light/personas/company-bot/CODEBUDDY.md
# - 目标：%USERPROFILE%\WorkBuddy\Claw\CODEBUDDY.md（WorkBuddy 只读这个位置）
# - 带指纹：打印源/目标 sha256；覆盖前自动备份到 <目标目录>\.anc-backup\
# - 可回滚：-Rollback 恢复最近一次备份
# 退出码：0 成功 / 1 校验失败 / 2 用法或环境错误

[CmdletBinding()]
param(
    [string]$Source = '',
    [string]$Target = "$env:USERPROFILE\WorkBuddy\Claw\CODEBUDDY.md",
    [switch]$Rollback,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

if (-not $Source) {
    $candidates = @(
        (Join-Path $PSScriptRoot '..\..\light\personas\company-bot\CODEBUDDY.md'), # 仓库 scripts/deploy
        (Join-Path $PSScriptRoot '..\light\personas\company-bot\CODEBUDDY.md')     # 部署 bin
    )
    $Source = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $Source) { $Source = $candidates[0] }
}

function Fail([string]$msg, [string]$fix, [int]$code) {
    Write-Host "ERROR $msg"
    Write-Host "FIX   $fix"
    exit $code
}

function Get-Sha([string]$path) {
    if (-not (Test-Path $path)) { return $null }
    (Get-FileHash $path -Algorithm SHA256).Hash.ToLower()
}

$targetDir = Split-Path -Parent $Target
$backupDir = Join-Path $targetDir '.anc-backup'

if ($Rollback) {
    if (-not (Test-Path $backupDir)) { Fail "没有备份目录: $backupDir" '先正常部署一次，备份会自动生成' 2 }
    $latest = Get-ChildItem $backupDir -Filter 'CODEBUDDY.*.md' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $latest) { Fail '没有可用的备份' '确认备份目录里有 CODEBUDDY.*.md' 2 }
    if (-not $DryRun) {
        Copy-Item $latest.FullName $Target -Force
        Write-Host "[persona] 已回滚到 $($latest.Name) sha=$((Get-Sha $Target))"
    } else {
        Write-Host "[persona] dry-run：将回滚到 $($latest.Name)（未写入）"
    }
    exit 0
}

if (-not (Test-Path $Source)) {
    # 部署目录里**没有** light\personas（deploy.ps1 只铺 light\templates），所以从 bin\ 跑必须传 -Source。
    Fail "源文件不存在: $Source" '仓库里跑：确认 light/personas/company-bot/CODEBUDDY.md 存在；部署目录里跑：必须显式传 -Source "<Root>\render\company-bot\CODEBUDDY.md"（部署目录不含 light\personas，persona 由 render 生成）' 2
}

$srcSha = Get-Sha $Source
$oldSha = Get-Sha $Target
$srcSize = (Get-Item $Source).Length

# 字节闸门必须和渲染器同一口径（src/modules/org/render.ts：LENGTH_WARN=6500 / LENGTH_ERROR=7500）。
# 2026-11-10 修：这里原来在 6500 直接 Fail，而渲染器只把 6500 当警告、7500 才拒绝 ——
# 于是渲染「成功」的 persona 到部署这一步装不上（线上那份已经 6470B，差 30 字节就卡死）。
if ($srcSize -gt 7500) {
    Fail "CODEBUDDY.md 超过 7500 字节（当前 $srcSize）" '精简 persona：只留身份、职责边界、铁律与输出风格（渲染器闸门同值）' 1
}
if ($srcSize -gt 6500) {
    Write-Host "[persona] 警告：$srcSize 字节，已过 6500 提醒线（上限 7500）。建议精简，否则下一次加段落就会装不上。"
}

if ($oldSha -eq $srcSha) {
    Write-Host "[persona] 已是最新，跳过（sha=$srcSha）"
    exit 0
}

if (-not $DryRun) {
    New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
    if (Test-Path $Target) {
        New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        $bak = Join-Path $backupDir "CODEBUDDY.$stamp.md"
        Copy-Item $Target $bak -Force
        Write-Host "[persona] 已备份旧版本 -> $bak (sha=$oldSha)"
    }
    Copy-Item $Source $Target -Force
}

$newSha = Get-Sha $Target
Write-Host "[persona] 部署完成 target=$Target"
Write-Host "[persona] source=$srcSha size=$srcSize"
Write-Host "[persona] target=$newSha"
Write-Host '[persona] 注意：CODEBUDDY.md 只在会话开始时读取，重启 WorkBuddy 或开新会话后生效。'
exit 0
