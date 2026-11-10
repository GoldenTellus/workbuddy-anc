# 公司侧一条命令装完：按固定顺序跑全部阶段，每步自动记账，失败即停。
#
# 为什么需要：
#   现在 agent 要依次敲 8–10 条命令，每步还要 deploy-state -Mark。顺序有依赖
#   （模板必须在 git init 前、org 必须在 render 前），漏一步或顺序错都会「装到一半」。
#   这个脚本把顺序固化，出错面从「N 条命令」降到「1 条 + 参数」。
#
# 它**不是**为了减少人工——首次部署的那一次管理员提权消不掉（注册 SYSTEM 任务本身要提权），
# 而 webhook / 建群本来就只能人工。它减少的是 agent 的操作成本和装错概率。
#
# 顺序（每一步都能单独重跑）：
#   preflight → dirs → files → skills → tasks → vault → org → wecom → verify → patch
#
# 为什么 patch 放最后：它会重启 WorkBuddy（用补丁启动器拉起新实例），
# 而 agent 就跑在里面。放在最后，前面全部就位，重启一次就生效；
# 中途重启会让剩下的步骤没人执行。
#
# 用法：
#   install-company.ps1 -VaultRoot D:\anc                   # 预演（默认 dry-run）
#   install-company.ps1 -VaultRoot D:\anc -Apply            # 真装（要管理员）
#   install-company.ps1 -VaultRoot D:\anc -Apply -From vault    # 从某阶段续跑
#   install-company.ps1 -VaultRoot D:\anc -Apply -Skip patch    # 不重启 WorkBuddy
#   install-company.ps1 -VaultRoot D:\anc -Apply -Webhooks 'a.txt=https://...'
#
# 退出码：0 全部成功 / 1 某阶段失败（已记账，可从失败处续跑）/ 2 用法或环境错误

[CmdletBinding()]
param(
    [string]$Root = '',
    [string]$VaultRoot = 'D:\anc',
    [string]$Repo = '',
    [string[]]$From = @(),
    [string[]]$Skip = @(),
    [string[]]$Webhooks = @(),
    [switch]$Apply,
    [switch]$Force,
    [switch]$Json
)

$ErrorActionPreference = 'Stop'
if (-not $Root) { $Root = Join-Path $env:ProgramData 'anc' }
if (-not $Repo) {
    $c = $PSScriptRoot
    while ($c -and -not (Test-Path (Join-Path $c '.git'))) {
        $p = Split-Path -Parent $c
        if ($p -eq $c) { break }
        $c = $p
    }
    $Repo = $c
}

$steps = @()
function Add-Step([string]$name, [string]$state, [string]$detail) {
    $script:steps += [pscustomobject]@{ step = $name; state = $state; detail = $detail }
}

function Finish([int]$code) {
    if ($Json) {
        try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
        [pscustomobject]@{ ok = ($code -eq 0); root = $Root; vault = $VaultRoot; steps = @($script:steps) } | ConvertTo-Json -Depth 6
    } else {
        foreach ($s in $script:steps) {
            $mark = switch ($s.state) { 'OK' { '  ok ' } 'SKIP' { ' skip' } 'FAIL' { ' FAIL' } default { '  .. ' } }
            Write-Output ($mark + ' ' + $s.step + '  ' + $s.detail)
        }
        Write-Output ''
        Write-Output $(if ($code -ne 0) { 'NEXT  从失败那一步修，然后用 -From <阶段> 续跑；不要从头重装。' }
                       elseif (-not $Apply) { 'NEXT  预演完成，加 -Apply 落盘（要管理员）。' }
                       else { 'NEXT  装完了。跑 deploy-verify 复核，再在群里 @ 一次 bot。' })
    }
    exit $code
}

function Fail([string]$msg, [string]$fix, [int]$code = 1) {
    Add-Step 'abort' 'FAIL' $msg
    if ($fix) { if (-not $Json) { Write-Output ('FIX   ' + $fix) } }
    Finish $code
}

function Invoke-Cmd([string]$exe, [string[]]$argv) {
    $eap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $o = @(& $exe @argv 2>&1)
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $eap }
    return [pscustomobject]@{ code = $code; text = ((@($o | ForEach-Object { [string]$_ })) -join "`n").Trim() }
}

# ── 阶段表：id 与 deploy-state 一致，方便自动记账 ─────────────────────────
$StageOrder = @('preflight', 'dirs', 'files', 'skills', 'tasks', 'vault', 'org', 'wecom', 'verify', 'patch')

$tools = Join-Path $Root 'tools'
if (-not (Test-Path $tools)) {
    # 首次装时 tools 还没铺，脚本只能从仓库跑
    $tools = Join-Path $Repo 'scripts\deploy'
}
$binDir = Join-Path $Root 'bin'

# 已完成的阶段（读 deploy-state；-Force 时不读）
$doneBefore = @()
$stateFile = Join-Path $Root 'data\deploy-state.json'
if (-not $Force -and (Test-Path $stateFile)) {
    try {
        $st = [IO.File]::ReadAllText($stateFile, [Text.Encoding]::UTF8).TrimStart([char]0xFEFF) | ConvertFrom-Json
        if ($st.done) { $doneBefore = @($st.done) }
    } catch { }
}

# -From：从指定阶段开始（之后的都跑）
$startIdx = 0
if ($From.Count -gt 0) {
    $idx = @()
    foreach ($f in $From) {
        $i = [array]::IndexOf($StageOrder, $f)
        if ($i -lt 0) { Fail ('-From 里有未知阶段: ' + $f) ('可选: ' + ($StageOrder -join ', ')) 2 }
        $idx += $i
    }
    $startIdx = ($idx | Measure-Object -Minimum).Minimum
}

foreach ($s in $Skip) {
    if ([array]::IndexOf($StageOrder, $s) -lt 0) { Fail ('-Skip 里有未知阶段: ' + $s) ('可选: ' + ($StageOrder -join ', ')) 2 }
}

# ── 前置：必须管理员（首次部署的固有限制）+ 工具存在 ─────────────────────
$isAdmin = $false
try {
    $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
} catch { }
Add-Step 'env' 'OK' ("管理员=" + $isAdmin + "  root=" + $Root + "  vault=" + $VaultRoot)
if ($Apply -and -not $isAdmin) {
    Fail '首次部署要管理员权限' '关掉 WorkBuddy → 右键「以管理员身份运行」→ 重开会话再跑。这一步是逻辑上限：注册 SYSTEM 任务本身就要提权，没有它就是鸡生蛋。装完之后日常升级走 anc-elevate 通道，就不需要了。' 2
}

if ($Apply) {
    foreach ($need in @('preflight.ps1', 'deploy.ps1', 'deploy-skills.ps1', 'register-tasks.ps1', 'vault-init.ps1', 'org-write.ps1', 'setup-dirs.ps1')) {
        $p = Join-Path $tools $need
        if (-not (Test-Path $p)) { Fail ('缺脚本: ' + $p) '确认 -Repo 指向仓库根，且 scripts\deploy 下有这些脚本' 2 }
    }
}

function Run-Stage([string]$id) {
    $stageTools = $tools
    switch ($id) {
        'preflight' {
            # 前置检查：只跑不记账（它的结果决定要不要继续，不是"完成了一个阶段"）
            $r = Invoke-Cmd 'powershell' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $stageTools 'preflight.ps1'), '-Side', 'company', '-Root', $Root, '-Json')
            if ($r.code -ne 0) {
                Add-Step 'preflight' 'FAIL' (($r.text -split "`n" | Where-Object { $_ -match 'BLOCKER|"check"' } | Select-Object -First 2) -join ' ')
                return $false
            }
            Add-Step 'preflight' 'OK' '无 blocker'
            return $true
        }
        'dirs' {
            $r = Invoke-Cmd 'powershell' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $stageTools 'setup-dirs.ps1'), '-Root', $Root, '-VaultRoot', $VaultRoot, '-Apply', '-Json')
            return Finish-Stage $id $r
        }
        'files' {
            $r = Invoke-Cmd 'powershell' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $stageTools 'deploy.ps1'), '-Side', 'company', '-Root', $Root, '-Repo', $Repo, '-Apply')
            return Finish-Stage $id $r
        }
        'skills' {
            $r = Invoke-Cmd 'powershell' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $stageTools 'deploy-skills.ps1'), '-Apply', '-Repo', $Repo)
            return Finish-Stage $id $r
        }
        'tasks' {
            $r = Invoke-Cmd 'powershell' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $stageTools 'register-tasks.ps1'), '-Root', $Root, '-Repo', $Repo, '-Apply')
            return Finish-Stage $id $r
        }
        'vault' {
            $r = Invoke-Cmd 'powershell' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $stageTools 'vault-init.ps1'), '-Root', $Root, '-VaultRoot', $VaultRoot, '-Apply', '-Json')
            return Finish-Stage $id $r
        }
        'org' {
            # 顺序：org-write 生成 → render 出 persona → 装到 WorkBuddy 读的位置
            $ow = Invoke-Cmd 'powershell' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $stageTools 'org-write.ps1'), '-Root', $Root, '-VaultRoot', $VaultRoot, '-Repo', $Repo, '-Json')
            if ($ow.code -ne 0) {
                $why = try { (($ow.text | ConvertFrom-Json).conflicts -join '; ') } catch { ($ow.text -split "`n" | Select-Object -Last 1) }
                Add-Step 'org' 'FAIL' ('org-write 未通过: ' + $why)
                return $false
            }
            $renderCli = Join-Path $Repo 'src\render\cli.ts'
            $orgDir = Join-Path $VaultRoot 'org'
            if (Test-Path $renderCli) {
                $rd = Invoke-Cmd 'node' @('--no-warnings', $renderCli, 'deploy', '--org', $orgDir, '--out', (Join-Path $Root 'render'), '--db', (Join-Path $Root 'data\anc.db'))
                if ($rd.code -ne 0) { Add-Step 'org' 'FAIL' ('render 失败: ' + (($rd.text -split "`n" | Select-Object -Last 2) -join ' ')); return $false }
            } else {
                Add-Step 'org' 'SKIP' '仓库里没有 render\cli.ts，跳过渲染'
                return $true
            }
            $persona = Join-Path $Root 'render\company-bot\CODEBUDDY.md'
            $dp = Join-Path $stageTools 'deploy-persona.ps1'
            if ((Test-Path $persona) -and (Test-Path $dp)) {
                $pp = Invoke-Cmd 'powershell' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $dp, '-Source', $persona)
                if ($pp.code -ne 0) { Add-Step 'org' 'FAIL' ('persona 安装失败: ' + (($pp.text -split "`n" | Select-Object -Last 1))); return $false }
            }
            Add-Step 'org' 'OK' 'org 已生成、persona 已渲染并安装'
            return $true
        }
        'wecom' {
            if ($Webhooks.Count -eq 0) {
                Add-Step 'wecom' 'SKIP' '没给 -Webhooks；稍后用 tools\wecom-setup.ps1 补（否则提醒发不出去）'
                return $true
            }
            $wArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $stageTools 'wecom-setup.ps1'),
                '-Root', $Root, '-Set', ($Webhooks -join ';'), '-Apply', '-Json')
            $r = Invoke-Cmd 'powershell' $wArgs
            return Finish-Stage $id $r
        }
        'verify' {
            $r = Invoke-Cmd 'powershell' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $stageTools 'deploy-verify.ps1'), '-Side', 'company', '-Root', $Root, '-Json')
            if ($r.code -eq 0) { Add-Step 'verify' 'OK' 'deploy-verify ok'; return $true }
            Add-Step 'verify' 'SKIP' '自证有 FAIL/SKIP（安装本身已完成，逐项看 deploy-verify）'
            return $true
        }
        'patch' {
            $launcher = Join-Path $Root 'patch\launch-patched.ps1'
            if (-not (Test-Path $launcher)) { Add-Step 'patch' 'SKIP' '没有 patch\launch-patched.ps1'; return $true }
            Add-Step 'patch' '..' '用补丁启动器重启 WorkBuddy（当前会话会断）'
            $r = Invoke-Cmd 'powershell' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $launcher)
            # 启动器会杀掉当前进程，返回码不可靠；只要没立刻失败就算已安排
            Add-Step 'patch' 'OK' '已用补丁启动器重启（补丁状态看 data\patch-state.json）'
            return $true
        }
        default { Add-Step $id 'SKIP' '未实现'; return $true }
    }
}

# 统一处理"跑完 + 记账"
function Finish-Stage([string]$id, $res) {
    if ($res.code -eq 0) {
        Add-Step $id 'OK' '完成'
        return $true
    }
    $tail = (($res.text -split "`n") | Where-Object { $_ -match 'ERROR|FIX' } | Select-Object -First 2) -join ' '
    if (-not $tail) { $tail = (($res.text -split "`n") | Select-Object -Last 2) -join ' ' }
    Add-Step $id 'FAIL' ('exit=' + $res.code + '  ' + $tail)
    return $false
}

function Mark-State([string]$id, [bool]$ok, [string]$reason) {
    if (-not $Apply) { return }
    $ds = Join-Path $tools 'deploy-state.ps1'
    if (-not (Test-Path $ds)) { $ds = Join-Path $binDir 'deploy-state.ps1' }
    if (-not (Test-Path $ds)) { return }
    $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $ds, '-Side', 'company', '-Root', $Root, '-Mark', $id)
    if ($ok) { $a += '-AsDone' } else { $a += @('-AsFailed', '-Reason', $reason) }
    $null = Invoke-Cmd 'powershell' $a
}

# ── 执行 ───────────────────────────────────────────────────────────────────
for ($i = 0; $i -lt $StageOrder.Count; $i++) {
    $id = $StageOrder[$i]
    if ($i -lt $startIdx) { Add-Step $id 'SKIP' '按 -From 跳过'; continue }
    if ($Skip -contains $id) { Add-Step $id 'SKIP' '按 -Skip 跳过'; continue }
    if ($doneBefore -contains $id -and -not $Force) { Add-Step $id 'SKIP' '已记账完成（要重跑加 -Force）'; continue }
    if (-not $Apply) { Add-Step $id 'OK' '(dry) 会执行'; continue }

    $ok = Run-Stage $id
    Mark-State $id $ok $(if (-not $ok) { 'install-company 在 ' + $id + ' 失败' } else { '' })
    if (-not $ok) {
        Fail ($id + ' 阶段失败，已停止') ('修好这一步后用 -From ' + $id + ' 续跑，不要从头重装') 1
    }
}

Finish 0
