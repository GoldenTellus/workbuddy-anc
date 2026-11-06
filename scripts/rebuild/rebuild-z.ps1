# O-5 干净机重建：用 Z:（VHD 独立卷）当"新机的 D 盘 + C 盘"，按 REBUILD §1/§3 从零装一遍
#
# 验的是：路径假设能不能换个盘符成立。不是"新机器能不能装"（那要真机）。
#
# 用法：powershell -File scripts\rebuild\rebuild-z.ps1 [-Keep]

[CmdletBinding()]
param(
    [string]$Repo = '',
    [switch]$Keep
)

$ErrorActionPreference = 'Stop'
if (-not $Repo) { $Repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path) }

if (-not (Test-Path 'Z:\')) { Write-Host 'ERROR Z: 不存在（先挂 VHD，见 VERIFY §33）'; exit 2 }

$A = 'Z:\anc-root'        # 模拟 %ProgramData%\anc
$VaultRoot = 'Z:\anc'             # 模拟 D:\anc
$steps = @()
function Step($name, $sb) {
    $t0 = Get-Date
    try { & $sb; $ok = $true; $err = '' }
    catch { $ok = $false; $err = $_.Exception.Message }
    $sec = [math]::Round(((Get-Date) - $t0).TotalSeconds, 1)
    $script:steps += [pscustomobject]@{ Name = $name; Sec = $sec; Ok = $ok; Err = $err }
    Write-Host ('  ' + $(if ($ok) { 'OK ' } else { 'XX ' }) + $name.PadRight(38) + $sec + 's' + $(if ($err) { '  ' + $err } else { '' }))
}

Write-Host '=== 干净机重建 @ Z: ==='
Write-Host "  仓库: $Repo"
Write-Host "  模拟 C 盘: $A"
Write-Host "  模拟 D 盘: $VaultRoot"
Write-Host ''

# 清场
if (Test-Path 'Z:\anc-root') { Remove-Item 'Z:\anc-root' -Recurse -Force -EA SilentlyContinue }
if (Test-Path 'Z:\anc') { Remove-Item 'Z:\anc' -Recurse -Force -EA SilentlyContinue }

# ── §1 新机准备 ─────────────────────
Step '§1 建 C 盘目录（15 个）' {
    'accounts','backup','bin','data','evals','inbox','ingest','light','patch','render','secrets','service','shared','skills','stage' |
        ForEach-Object { New-Item -ItemType Directory -Force (Join-Path $A $_) | Out-Null }
}


Step '§1 设 secrets / data 的 ACL' {
    # 2026-11-05 加：目录建完必须立刻设 ACL，否则 doctor 的 secrets-acl / data-acl 会红。
    # 原来这一步是人工敲的，清空重装后会全部丢失（VERIFY §65）。
    $setAcl = Join-Path $PSScriptRoot 'set-acl.ps1'
    if (-not (Test-Path $setAcl)) { $setAcl = Join-Path $PSScriptRoot '..\deploy\set-acl.ps1' }
    if (Test-Path $setAcl) {
        # -SkipVerify 必须带：§3 的 deploy.ps1 才会把 bin\doctor.ps1 铺过去，
        # 这里自检找不到 doctor 就会 exit 2，把整场演练判成失败（ACL 其实已经设好）。
        # deploy.ps1 自己会再设一次 ACL，部署完单独跑 doctor 才是完整验证。
        & powershell -NoProfile -ExecutionPolicy Bypass -File $setAcl -Root $A -Apply -SkipVerify
        if ($LASTEXITCODE -ne 0) { throw ('设 ACL 失败（exit ' + $LASTEXITCODE + '）') }
    }
}

Step '§1 建 D 盘目录（5 个）' {
    'vault-shared','vault-internal','inbox','org','build' |
        ForEach-Object { New-Item -ItemType Directory -Force (Join-Path $VaultRoot $_) | Out-Null }
    # org 至少要有 company.md，否则渲染器读不到
    New-Item -ItemType Directory -Force (Join-Path $VaultRoot 'org\members') | Out-Null
    @"
---
name: 演练公司
company_bot_name: 演练 bot
vault_shared: $VaultRoot\vault-shared
vault_internal: $VaultRoot\vault-internal
local_workdir: $A
---
"@ | Set-Content (Join-Path $VaultRoot 'org\company.md') -Encoding UTF8
}

Step '§1 vault 建 git（模拟有历史）' {
    foreach ($v in 'vault-shared','vault-internal') {
        $p = Join-Path $VaultRoot $v
        & git -C $p init -q 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "git init 失败: $p (exit=$LASTEXITCODE)" }
        'placeholder' | Set-Content (Join-Path $p 'README.md') -Encoding UTF8
        & git -C $p add -A 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "git add 失败: $p (exit=$LASTEXITCODE)" }
        & git -C $p -c user.name=t -c user.email=t@t commit -q -m init 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "git commit 失败: $p (exit=$LASTEXITCODE)" }
    }
}

# ── §3 装服务与任务 ─────────────────
Step '§3 deploy.ps1 -Apply' {
    $out = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Repo 'scripts\deploy\deploy.ps1') -Repo $Repo -Root $A -Apply 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) { throw "deploy 退出码 $LASTEXITCODE`: $($out.Substring(0, [Math]::Min(200, $out.Length)))" }
}

Step '§3 装技能（deploy-skills）' {
    # 落盘到演练根的 skills 目录，不动真实的 %USERPROFILE%\.workbuddy
    $skillRoot = Join-Path $A 'skills-live'
    New-Item -ItemType Directory -Force $skillRoot | Out-Null
    $out = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Repo 'scripts\deploy\deploy-skills.ps1') `
        -Repo $Repo -Target $skillRoot -Apply 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) { throw "deploy-skills 退出码 $LASTEXITCODE`: $($out.Substring(0, [Math]::Min(200, $out.Length)))" }
}

# ── 验证：装出来的东西对不对 ─────────
Step '验证 部署文件数' {
    $n = @(Get-ChildItem (Join-Path $A 'service') -File -Recurse).Count
    if ($n -lt 10) { throw "service 下只有 $n 个文件，太少" }
}

Step '验证 技能落盘' {
    $n = @(Get-ChildItem (Join-Path $A 'skills-live') -Directory -EA SilentlyContinue).Count
    if ($n -lt 7) { throw "技能只有 $n 个，应 ≥7" }
}

Step '验证 cli 能跑（空库建表）' {
    $db = Join-Path $A 'data\anc.db'
    $cli = Join-Path $A 'service\cli.ts'
    $out = & node --no-warnings $cli --db $db --json config list 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) { throw "cli 退出码 $LASTEXITCODE`: $out" }
    $j = $out | ConvertFrom-Json
    if (-not $j) { throw 'cli 没有返回 JSON' }
}

Step '验证 company.md 路径指向 Z:' {
    $c = Get-Content (Join-Path $VaultRoot 'org\company.md') -Raw
    if ($c -notmatch 'Z:\\anc\\vault-shared') { throw 'company.md 没指向 Z:' }
}

Step '验证 渲染器能读 org' {
    $out = & node --no-warnings (Join-Path $A 'render\cli.ts') deploy --org (Join-Path $VaultRoot 'org') --out (Join-Path $VaultRoot 'build') --json 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) { throw "render 退出码 $LASTEXITCODE`: $($out.Substring(0, [Math]::Min(300, $out.Length)))" }
}

# ── doctor（这里会暴露硬编码问题）─────────
Step 'doctor -Root Z:\anc-root' {
    # -VaultRoot 必须传：doctor 默认查生产 D:\anc，演练根的 #11/#20 会被生产 vault 污染（VERIFY §34）
    $out = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Repo 'scripts\doctor\doctor.ps1') -Repo $Repo -Root $A -VaultRoot $VaultRoot 2>&1 | Out-String
    $summary = ($out -split "`r?`n" | Where-Object { $_ -match 'FAIL=' }) -join ''
    $fails = @($out -split "`r?`n" | Where-Object { $_ -match '^FAIL' })
    $warns = @($out -split "`r?`n" | Where-Object { $_ -match '^WARN' })
    Write-Host ('       ' + $summary)
    if ($fails.Count) { $fails | ForEach-Object { Write-Host ('       ' + $_.Substring(0, [Math]::Min(120, $_.Length))) } }
    if ($warns.Count) { $warns | ForEach-Object { Write-Host ('       W ' + $_.Substring(0, [Math]::Min(118, $_.Length))) } }
    # 不 throw：doctor 有 FAIL 正是我们要观察的现象
}

Write-Host ''
Write-Host '========== 汇总 =========='
$total = [math]::Round(($steps | Measure-Object -Property Sec -Sum).Sum, 1)
$okN = @($steps | Where-Object { $_.Ok }).Count
foreach ($s in $steps) { Write-Host ('  ' + $(if ($s.Ok) { 'OK ' } else { 'XX ' }) + $s.Name.PadRight(38) + $s.Sec + 's') }
Write-Host ''
Write-Host "  $okN / $($steps.Count) 步成功   合计 $total s"

if (-not $Keep) {
    Write-Host ''
    Write-Host '  演练根保留（-Keep 没用，删了就没法看）；清理：Remove-Item Z:\anc-root,Z:\anc -Recurse -Force'
}

exit $(if ($okN -eq $steps.Count) { 0 } else { 1 })
