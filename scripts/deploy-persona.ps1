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

if (-not $Source) { $Source = Join-Path $PSScriptRoot '..\light\personas\company-bot\CODEBUDDY.md' }

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

if (-not (Test-Path $Source)) { Fail "源文件不存在: $Source" '确认 light/personas/company-bot/CODEBUDDY.md 在仓库里' 2 }

$srcSha = Get-Sha $Source
$oldSha = Get-Sha $Target
$srcSize = (Get-Item $Source).Length

if ($srcSize -gt 6500) {
    Fail "CODEBUDDY.md 超过 6500 字节（当前 $srcSize）" '精简 persona：只留身份、职责边界、铁律与输出风格' 1
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
