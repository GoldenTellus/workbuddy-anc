# 部署技能：light\skills\*\  →  %USERPROFILE%\.workbuddy\skills\<技能名>\
#
# 为什么单独一个脚本：deploy.ps1 的所有 Target 都相对 %ProgramData%\anc，
# 而技能要装到 %USERPROFILE%\.workbuddy\skills\——不在同一个根下。
# 2026-11-04 之前技能是手工复制的（REBUILD L64 写的是"安装技能到…"），
# 那违反「只走 git → 部署」：手抄一次就可能和仓库不一致，而且没人知道差在哪。
#
# **落盘目录用 SKILL.md 里的 name: 字段，不是仓库目录名。**
# 例：仓库目录 anc-ingest-company，但 SKILL.md 写 name: anc-ingest，persona 也引用 anc-ingest。
# 按目录名落盘会造出两个同名技能，bot 侧会冲突。
#
# 用法：
#   powershell -File scripts\deploy-skills.ps1                    # 预检（只比对，不写）
#   powershell -File scripts\deploy-skills.ps1 -Apply             # 真部署
#   powershell -File scripts\deploy-skills.ps1 -Apply -RemoveExtra # 顺便删掉线上多出来的技能
#   powershell -File scripts\deploy-skills.ps1 -Rollback          # 恢复最近一次备份
#
# 退出码：0 成功 / 1 校验失败 / 2 用法或环境错误

[CmdletBinding()]
param(
    [string]$Repo = '',
    [string]$Target = '',
    [switch]$Apply,
    [switch]$Rollback,
    [switch]$RemoveExtra
)

$ErrorActionPreference = 'Stop'
function Fail($msg, $fix, $code) { Write-Host "ERROR $msg"; if ($fix) { Write-Host "FIX   $fix" }; exit $code }

if (-not $Repo) { $Repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path) }
if (-not (Test-Path $Repo)) { Fail "仓库不存在: $Repo" '用 -Repo 指向仓库根' 2 }
$srcRoot = Join-Path $Repo 'light\skills'
if (-not (Test-Path $srcRoot)) { Fail "没有 light\skills: $srcRoot" '确认仓库结构' 2 }
if (-not $Target) { $Target = Join-Path $env:USERPROFILE '.workbuddy\skills' }
$backupRoot = Join-Path $Target '.anc-backup'

# ── 回滚 ────────────────────────────────────────────────
if ($Rollback) {
    if (-not (Test-Path $backupRoot)) { Fail "没有备份目录: $backupRoot" '从来没部署过？' 2 }
    $latest = Get-ChildItem $backupRoot -Directory | Sort-Object Name -Descending | Select-Object -First 1
    if (-not $latest) { Fail "备份目录是空的: $backupRoot" $null 2 }
    Write-Host "[skills] 回滚自 $($latest.FullName)"
    Get-ChildItem $latest.FullName -Directory | ForEach-Object {
        $dst = Join-Path $Target $_.Name
        if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
        Copy-Item $_.FullName $dst -Recurse -Force
        Write-Host "  恢复 $($_.Name)"
    }
    Write-Host "[skills] 回滚完成。重启 WorkBuddy 或开新会话后生效。"
    exit 0
}

# ── 收集技能（目录名 ≠ 技能名）──────────────────────────
$skills = @()
foreach ($dir in @(Get-ChildItem $srcRoot -Directory)) {
    $skillMd = Join-Path $dir.FullName 'SKILL.md'
    if (-not (Test-Path $skillMd)) { continue }
    $skillName = $null
    foreach ($line in @(Get-Content $skillMd -TotalCount 15 -ErrorAction SilentlyContinue)) {
        if ($line -match '^name:\s*(\S+)\s*$') { $skillName = $matches[1]; break }
    }
    if (-not $skillName) { $skillName = $dir.Name }
    $skills += [pscustomobject]@{
        DirName = $dir.Name
        Name    = $skillName
        Path    = $dir.FullName
    }
}
if ($skills.Count -eq 0) { Fail "light\skills 下没有带 SKILL.md 的技能" '确认目录结构' 2 }

# 同名技能检测（两个目录声称同一个 name 会互相覆盖）
$dupes = @($skills | Group-Object Name | Where-Object { $_.Count -gt 1 })
if ($dupes.Count -gt 0) {
    $dupes | ForEach-Object { Write-Host "ERROR 两个仓库目录声称同一个技能名: $($_.Name) ← $($_.Group.DirName -join ', ')" }
    Fail "技能名冲突" '改掉其中一个 SKILL.md 的 name: 字段' 2
}

# ── 生成计划 ────────────────────────────────────────────
$plan = @()
foreach ($sk in $skills) {
    foreach ($f in @(Get-ChildItem $sk.Path -File -Filter '*.md')) {
        $dst = Join-Path (Join-Path $Target $sk.Name) $f.Name
        $plan += [pscustomobject]@{
            Skill   = $sk.Name
            DirName = $sk.DirName
            Name    = $f.Name
            Src     = $f.FullName
            Dst     = $dst
            SrcHash = (Get-FileHash $f.FullName -Algorithm SHA256).Hash
            DstHash = if (Test-Path $dst) { (Get-FileHash $dst -Algorithm SHA256).Hash } else { $null }
        }
    }
}

Write-Host "[skills] 源:   $srcRoot"
Write-Host "[skills] 目标: $Target"
Write-Host "[skills] 技能 $($skills.Count) 个，文件 $($plan.Count) 个"
foreach ($sk in $skills) {
    if ($sk.DirName -ne $sk.Name) {
        Write-Host "  注意：目录 $($sk.DirName) 的技能名是 $($sk.Name)，按后者落盘"
    }
}

$same = @($plan | Where-Object { $_.DstHash -eq $_.SrcHash })
$diff = @($plan | Where-Object { $_.DstHash -ne $_.SrcHash })
Write-Host "`n[skills] 一致 $($same.Count)，需更新 $($diff.Count)"
foreach ($d in $diff) {
    $why = if (-not $d.DstHash) { '新增' } else { '内容不同' }
    Write-Host ("  {0,-20} {1,-16} {2}" -f $d.Skill, $d.Name, $why)
}

# 线上有、仓库没有的技能（手工装的残留）
$repoNames = @($skills | ForEach-Object { $_.Name })
$extra = @()
if (Test-Path $Target) {
    $extra = @(Get-ChildItem $Target -Directory |
        Where-Object { $_.Name -ne '.anc-backup' -and ($repoNames -notcontains $_.Name) } |
        ForEach-Object { $_.Name })
}
if ($extra.Count) {
    Write-Host "`n[skills] 线上有、仓库没有的技能（$($extra.Count) 个）："
    $extra | ForEach-Object { Write-Host "  $_" }
    Write-Host "  手工装的残留。加 -RemoveExtra 会删掉（会先备份）；不加就保留。"
}

if (-not $Apply) {
    Write-Host "`n[skills] 预检模式，没有写入。加 -Apply 才真正部署。"
    exit 0
}

# ── 备份 + 写入 ─────────────────────────────────────────
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupDir = Join-Path $backupRoot $stamp
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null

if ($diff.Count -eq 0) {
    Write-Host "[skills] 没有需要更新的文件。"
} else {
    foreach ($d in $diff) {
        $dstDir = Split-Path -Parent $d.Dst
        New-Item -ItemType Directory -Path $dstDir -Force | Out-Null
        if (Test-Path $d.Dst) {
            $bDir = Join-Path $backupDir $d.Skill
            New-Item -ItemType Directory -Path $bDir -Force | Out-Null
            Copy-Item $d.Dst (Join-Path $bDir $d.Name) -Force
        }
        Copy-Item $d.Src $d.Dst -Force
    }
}

if ($RemoveExtra -and $extra.Count -gt 0) {
    foreach ($e in $extra) {
        $p = Join-Path $Target $e
        $bDir = Join-Path $backupDir $e
        New-Item -ItemType Directory -Path $bDir -Force | Out-Null
        Copy-Item $p $bDir -Recurse -Force
        Remove-Item $p -Recurse -Force
        Write-Host "  删除残留 $e（已备份）"
    }
}

# ── 校验 ────────────────────────────────────────────────
$bad = 0
foreach ($d in $plan) {
    if (-not (Test-Path $d.Dst)) { Write-Host "  x 缺失 $($d.Dst)"; $bad++; continue }
    $h = (Get-FileHash $d.Dst -Algorithm SHA256).Hash
    if ($h -ne $d.SrcHash) { Write-Host "  x 校验不符 $($d.Dst)"; $bad++ }
}
if ($bad -gt 0) { Fail "部署后校验失败 $bad 个文件" '检查磁盘写入权限' 1 }

Write-Host "`n[skills] 部署完成：$($diff.Count) 个文件更新，$($plan.Count) 个全部校验通过。"
Write-Host "[skills] 备份: $backupDir"
Write-Host "[skills] 注意：技能在**新会话**才生效（WorkBuddy 每会话首次注入时读盘，见 VERIFY 18）。"
exit 0
