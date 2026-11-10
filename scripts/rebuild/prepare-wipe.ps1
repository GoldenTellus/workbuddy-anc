# prepare-wipe.ps1 —— 把本机清成「干净机」，用于 C4/C6 的从零重建验证
#
# 设计原则：
#   1. 默认只演练（-WhatIf），不加 -Apply 不动机器
#   2. 一律「改名」不「删除」，留一条退路（回滚就是把名字改回来）
#   3. 每步打时间戳，直接产出 C4 要的计时表
#   4. 只留 E:\workbuddy-anc（重建的唯一真相源）
#
# 退出码：0 成功 / 1 有步骤失败 / 2 用法错误

[CmdletBinding()]
param(
    [switch]$Apply,
    [string]$Repo = 'E:\workbuddy-anc',
    [string]$BackupRoot = 'E:\anc-backup-20261104'
)

$ErrorActionPreference = 'Stop'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$results = New-Object System.Collections.Generic.List[object]

function Step([string]$name, [string]$path) {
    $t0 = Get-Date
    $exists = Test-Path $path
    $sizeMB = 0; $files = 0
    if ($exists) {
        $f = @(Get-ChildItem $path -Recurse -File -ErrorAction SilentlyContinue)
        $files = $f.Count
        $sizeMB = [Math]::Round((($f | Measure-Object Length -Sum).Sum)/1MB, 1)
    }
    return [pscustomobject]@{ Name = $name; Path = $path; Exists = $exists; Files = $files; SizeMB = $sizeMB; T0 = $t0 }
}

Write-Host ''
Write-Host '=== 清空演练：本机 -> 干净机 ==='
Write-Host ("模式: " + $(if ($Apply) { 'APPLY（会真改机器）' } else { 'WhatIf（只打印，不改任何东西加 -Apply 才执行）' }))
Write-Host ("时间: " + (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))
Write-Host ''

# ── 1. 前置检查
Write-Host '--- 前置 ---'
if (-not (Test-Path $Repo)) { Write-Host "  ERROR 仓库不存在: $Repo"; exit 2 }
$gitHead = (git -C $Repo rev-parse --short HEAD 2>&1) -join ''
$ahead = [int]((git -C $Repo rev-list --count 'origin/main..HEAD' 2>&1) -join '')
$dirty = @(git -C $Repo status --porcelain 2>&1)
Write-Host ("  仓库 HEAD: " + $gitHead)
Write-Host ("  未推送提交: " + $ahead + $(if ($ahead -gt 0) { '  [注意] 仓库目录在清空中是保留的，但建议先推' } else { '' }))
Write-Host ("  工作区: " + $(if ($dirty.Count) { '有 ' + $dirty.Count + ' 处改动' } else { '干净' }))
if (-not (Test-Path $BackupRoot)) { Write-Host ("  ERROR 备份目录不存在: " + $BackupRoot); exit 2 }
Write-Host ("  备份目录: OK")

$wb = Join-Path $env:LOCALAPPDATA 'Programs\WorkBuddy\WorkBuddy.exe'
if (Test-Path $wb) { Write-Host ("  WorkBuddy: " + (Get-Item $wb).VersionInfo.FileVersion) }
else { Write-Host '  WorkBuddy: 未安装' }
Write-Host ''

# ── 2. 目标清单
Write-Host '--- 要动的目标 ---'
$targets = @(
    @{ N = '公司侧部署';   P = 'C:\ProgramData\anc' },
    @{ N = '员工侧部署';   P = (Join-Path $env:LOCALAPPDATA 'anc') },
    @{ N = 'WorkBuddy 用户数据'; P = (Join-Path $env:USERPROFILE '.workbuddy') },
    @{ N = 'WorkBuddy 工作区';   P = (Join-Path $env:USERPROFILE 'WorkBuddy') },
    @{ N = 'D 盘 anc 数据';      P = 'D:\anc' }
)
$steps = @()
foreach ($t in $targets) {
    $s = Step $t.N $t.P
    $steps += $s
    Write-Host ("  {0,-20} {1,-46} {2,6} 文件 {3,8} MB  {4}" -f $s.Name, $s.Path, $s.Files, $s.SizeMB, $(if ($s.Exists) { '存在' } else { '不存在（跳过）' }))
}
Write-Host ("  {0,-20} {1,-46} {2}" -f '仓库（保留）', $Repo, '不动')
Write-Host ''

# ── 3. 计划任务
Write-Host '--- 计划任务 ---'
$tasks = @(Get-ScheduledTask -TaskName 'anc-*' -ErrorAction SilentlyContinue)
Write-Host ("  要注销 " + $tasks.Count + " 个:")
$tasks | ForEach-Object { Write-Host ("    " + $_.TaskName + "  " + $_.State + "  " + $_.Principal.UserId) }
Write-Host ''

# ── 4. 执行
if (-not $Apply) {
    Write-Host '=== WhatIf：以上是计划，加 -Apply 才执行 ==='
    Write-Host '回滚方式：把各目录的 -prewipe 后缀去掉即可。'
    Write-Host ''
    exit 0
}

Write-Host '=== APPLY：开始执行 ==='
$fail = 0

# 4.1 停进程
Write-Host '--- 停进程 ---'
$t0 = Get-Date
Get-Process -Name WorkBuddy -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object { $_.Id -ne $PID } | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 8
Write-Host ("  WorkBuddy: " + @(Get-Process -Name WorkBuddy -ErrorAction SilentlyContinue).Count + "  node: " + @(Get-Process -Name node -ErrorAction SilentlyContinue).Count)
Write-Host ("  耗时 " + [Math]::Round(((Get-Date)-$t0).TotalSeconds,1) + " 秒")
Write-Host ''

# 4.2 注销任务
Write-Host '--- 注销任务 ---'
$t0 = Get-Date
foreach ($tk in $tasks) {
    try {
        Unregister-ScheduledTask -TaskName $tk.TaskName -Confirm:$false -ErrorAction Stop
        Write-Host ("  OK   " + $tk.TaskName)
    } catch {
        Write-Host ("  FAIL " + $tk.TaskName + ": " + $_.Exception.Message)
        $fail++
    }
}
Write-Host ("  耗时 " + [Math]::Round(((Get-Date)-$t0).TotalSeconds,1) + " 秒")
Write-Host ''

# 4.3 改名各目录
Write-Host '--- 改名目录（不删除）---'
foreach ($s in $steps) {
    if (-not $s.Exists) { Write-Host ("  SKIP " + $s.Name); continue }
    $t0 = Get-Date
    $newName = (Split-Path $s.Path -Leaf) + "-prewipe-" + $stamp
    $parent = Split-Path $s.Path -Parent
    $dst = Join-Path $parent $newName
    try {
        Rename-Item $s.Path -NewName $newName -ErrorAction Stop
        $secs = [Math]::Round(((Get-Date)-$t0).TotalSeconds,1)
        Write-Host ("  OK   " + $s.Name + " -> " + $newName + "  (" + $s.Files + " 文件/" + $s.SizeMB + " MB, " + $secs + " 秒)")
        $results.Add([pscustomobject]@{ Step = $s.Name; Files = $s.Files; SizeMB = $s.SizeMB; Seconds = $secs; Status = 'renamed' })
    } catch {
        Write-Host ("  FAIL " + $s.Name + ": " + $_.Exception.Message)
        $results.Add([pscustomobject]@{ Step = $s.Name; Files = $s.Files; SizeMB = $s.SizeMB; Seconds = 0; Status = 'failed' })
        $fail++
    }
}
Write-Host ''

# 4.4 清空后核对
Write-Host '--- 清空后核对 ---'
$clean = $true
foreach ($t in $targets) {
    $ex = Test-Path $t.P
    Write-Host ("  " + $t.N.PadRight(20) + $(if ($ex) { '仍然存在  <-- 没清掉' } else { '已清空 OK' }))
    if ($ex) { $clean = $false }
}
Write-Host ("  仓库保留: " + (Test-Path $Repo) + $(if (Test-Path $Repo) { ' OK' } else { '  <-- 出问题了' }))
Write-Host ("  anc-* 任务: " + @(Get-ScheduledTask -TaskName 'anc-*' -ErrorAction SilentlyContinue).Count)
Write-Host ''

# ── 5. 输出计时表
Write-Host '=== 计时表（C4 用）==='
$results | Format-Table -AutoSize | Out-String | Write-Host
Write-Host ''
Write-Host '=== 回滚方式 ==='
Write-Host '  把各目录名的 -prewipe-' + $stamp + ' 后缀去掉即可，例如：'
Write-Host ('    Rename-Item "C:\ProgramData\anc-prewipe-' + $stamp + '" "anc"')
Write-Host '  任务用 register-tasks.ps1 -Apply 重新注册。'
Write-Host ''
Write-Host '=== 下一步 ==='
Write-Host '  1. 让用户开一个新的 DSH 会话（不要继承当前上下文）'
Write-Host '  2. 把提示词发过去：照仓库里的 docs/DEPLOY-COMPANY.md 从零装公司侧'
Write-Host '  3. 逐节计时，记录每次卡点'
Write-Host ''

if ($fail -gt 0) { Write-Host ("有 " + $fail + " 个步骤失败"); exit 1 }
Write-Host '全部完成'
exit 0
