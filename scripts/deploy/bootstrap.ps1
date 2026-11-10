# 零起点引导：让 agent 在一台新机器上把「装依赖 → 环境就绪」走完。
#
# 为什么需要它：
#   给 agent 一个仓库链接，它能 clone、能读文档，但**新机器上没有 Node 和 Git**。
#   preflight 只会报 blocker 说「装 Node 22 LTS」，然后人就得去找安装包。
#   而这个场景里 agent 本来就有管理员权限 + winget，这件事它能自己做完。
#
# 边界（重要）：
#   本脚本**只负责运行环境**：Node、Git、PATH 刷新、仓库位置检查。
#   它不装 WorkBuddy（装不了自己）、不建群、不碰任何部署目录。
#   做完之后把控制权交给 preflight 和 deploy-kickoff。
#
# 顺序：
#   bootstrap.ps1 -InstallDeps        # 缺什么装什么，装完刷新 PATH
#   preflight.ps1 -Side company       # 全面体检（含 agent 是否管理员）
#   deploy-kickoff.ps1 -Phase identity
#
# 用法：
#   bootstrap.ps1                                  # 只检查，不装
#   bootstrap.ps1 -InstallDeps                     # 缺就装（winget，要管理员）
#   bootstrap.ps1 -InstallDeps -CloneTo C:\anc-repo  # 顺带 clone 到指定位置
#   bootstrap.ps1 -InstallDeps -Json
#
# 退出码：0 环境就绪 / 1 依赖仍然缺失 / 2 用法错误

[CmdletBinding()]
param(
    [string]$Repo = '',
    # 仓库不存在时 clone 到这里（agent 通常已经 clone 过，这个参数是给「还没 clone」的场景）
    [string]$CloneTo = '',
    [string]$Branch = 'main',
    [string]$Remote = 'https://github.com/GoldenTellus/workbuddy-anc.git',
    [switch]$InstallDeps,
    [switch]$Json
)

$ErrorActionPreference = 'Stop'

$steps = @()
function Add-Step([string]$name, [string]$state, [string]$detail) {
    $script:steps += [pscustomobject]@{ step = $name; state = $state; detail = $detail }
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

function Refresh-Path {
    # winget 装完只改注册表，当前进程的 PATH 还是旧的。
    # 不重建的话，后面 `node -v` 依然找不到——看起来像「装失败」。
    try {
        $m = [Environment]::GetEnvironmentVariable('Path', 'Machine')
        $u = [Environment]::GetEnvironmentVariable('Path', 'User')
        $env:Path = ($m, $u | Where-Object { $_ }) -join ';'
    } catch { }
}

function Test-Tool([string]$name, [string]$exe, [int]$minMajor = 0) {
    $cmd = Get-Command $exe -ErrorAction SilentlyContinue
    if (-not $cmd) { return [pscustomobject]@{ ok = $false; ver = ''; why = '找不到命令' } }
    $ver = ''
    try { $ver = ((Invoke-Cmd $exe @('--version')).text -split "`n")[0].Trim() } catch { }
    if ($minMajor -gt 0 -and $ver -match '(\d+)\.') {
        if ([int]$matches[1] -lt $minMajor) {
            return [pscustomobject]@{ ok = $false; ver = $ver; why = ('版本太低，要 ' + $minMajor + '+') }
        }
    }
    return [pscustomobject]@{ ok = $true; ver = $ver; why = '' }
}

function Finish([int]$code) {
    $nodeOk = (Test-Tool 'node' 'node' 22).ok
    $gitOk = (Test-Tool 'git' 'git').ok
    $obj = [ordered]@{
        ok    = ($nodeOk -and $gitOk)
        node  = $(if ($nodeOk) { $nodeVer } else { '缺失/过低' })
        git   = $(if ($gitOk) { $gitVer } else { '缺失' })
        repo  = $Repo
        steps = @($script:steps)
        next  = if (-not $nodeOk -or -not $gitOk) {
            '依赖还缺：加 -InstallDeps 让我用 winget 装（要管理员）；没有 winget 就手动装 Node 22 LTS 和 Git for Windows，装完重开会话。'
        } elseif ($code -eq 0) {
            '环境就绪。下一步：scripts\deploy\preflight.ps1 -Side company -Json'
        } else { '看 steps 里的 FAIL。' }
    }
    if ($Json) {
        try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
        $obj | ConvertTo-Json -Depth 6
    } else {
        foreach ($s in $script:steps) {
            $mark = switch ($s.state) { 'OK' { '  ok ' } 'SKIP' { ' skip' } 'FAIL' { ' FAIL' } default { '  .. ' } }
            Write-Output ($mark + ' ' + $s.step + '  ' + $s.detail)
        }
        Write-Output ''
        Write-Output ('NEXT  ' + $obj.next)
    }
    exit $code
}

# ── 0 仓库位置 ─────────────────────────────────────────────────────────────
if (-not $Repo) {
    $c = $PSScriptRoot
    while ($c -and -not (Test-Path (Join-Path $c '.git'))) {
        $p = Split-Path -Parent $c
        if ($p -eq $c) { break }
        $c = $p
    }
    $Repo = $c
}

if (-not $Repo -or -not (Test-Path $Repo)) {
    if ($CloneTo) {
        $gitProbe = Test-Tool 'git' 'git'
        if (-not $gitProbe.ok -and -not $InstallDeps) {
            Add-Step 'repo' 'FAIL' '要 clone 但本机没有 git'
            Finish 1
        }
    } else {
        Add-Step 'repo' 'FAIL' '没有仓库（-Repo 没给，也不在 git 仓库里）'
        $obj = [ordered]@{ ok = $false; next = '用 -Repo 指向已 clone 的仓库，或 -CloneTo <目录> 让我 clone。' }
        if ($Json) { $obj | ConvertTo-Json -Depth 4 } else { Write-Output 'ERROR 没有仓库'; Write-Output ('FIX   ' + $obj.next) }
        exit 2
    }
}

# ── 1 依赖：Node / Git ─────────────────────────────────────────────────────
$nodeVer = ''; $gitVer = ''
$node = Test-Tool 'node' 'node' 22
$git = Test-Tool 'git' 'git'
if ($node.ok) { $nodeVer = $node.ver; Add-Step 'node' 'OK' $node.ver }
else { Add-Step 'node' 'FAIL' ($node.why + $(if ($node.ver) { '（' + $node.ver + '）' } else { '' })) }
if ($git.ok) { $gitVer = $git.ver; Add-Step 'git' 'OK' $git.ver }
else { Add-Step 'git' 'FAIL' $git.why }

$needInstall = @()
if (-not $node.ok) { $needInstall += 'node' }
if (-not $git.ok) { $needInstall += 'git' }

if ($needInstall.Count -gt 0) {
    if (-not $InstallDeps) {
        Add-Step 'install' 'SKIP' ('缺: ' + ($needInstall -join ', ') + '；加 -InstallDeps 自动装')
        Finish 1
    }

    $isAdmin = $false
    try {
        $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
            [Security.Principal.WindowsBuiltInRole]::Administrator)
    } catch { }
    if (-not $isAdmin) {
        Add-Step 'install' 'FAIL' '要管理员才能装（Node/Git 装到机器级）'
        Finish 1
    }

    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if (-not $winget) {
        Add-Step 'install' 'FAIL' '没有 winget（Win10 LTSC 或精简系统常见）'
        Write-Output '      手动装这两个再重开会话：'
        Write-Output '        Node 22 LTS  https://nodejs.org/en/download'
        Write-Output '        Git for Windows  https://git-scm.com/download/win'
        Finish 1
    }

    $pkgs = @()
    if ($needInstall -contains 'node') { $pkgs += @{ Id = 'OpenJS.NodeJS.LTS'; Name = 'Node LTS' } }
    if ($needInstall -contains 'git') { $pkgs += @{ Id = 'Git.Git'; Name = 'Git' } }

    foreach ($p in $pkgs) {
        Add-Step ('winget:' + $p.Name) '..' '安装中（静默，可能要几分钟）'
        # --disable-interactivity：winget 默认会问确认，无人值守时会挂住
        $r = Invoke-Cmd 'winget' @('install', '--id', $p.Id, '-e', '--silent',
            '--accept-source-agreements', '--accept-package-agreements', '--disable-interactivity')
        $installed = ($r.code -eq 0) -or ($r.text -match 'already installed|已安装')
        if ($installed) { Add-Step ('winget:' + $p.Name) 'OK' '已安装' }
        else { Add-Step ('winget:' + $p.Name) 'FAIL' (($r.text -split "`n" | Select-Object -Last 2) -join ' ') }
    }

    Refresh-Path
    Add-Step 'path' 'OK' '已从注册表重读 PATH（当前会话生效）'

    $node2 = Test-Tool 'node' 'node' 22
    $git2 = Test-Tool 'git' 'git'
    if (-not $node2.ok -or -not $git2.ok) {
        Add-Step 'recheck' 'FAIL' ('装完仍不可用：' + $(if (-not $node2.ok) { 'node ' } else { '' }) + $(if (-not $git2.ok) { 'git' } else { '' }))
        Finish 1
    }
    Add-Step 'recheck' 'OK' ($node2.ver + ' / ' + $git2.ver)
}

# ── 2 仓库位置（-CloneTo 且目录不存在时 clone）─────────────────────────────
if ($CloneTo -and -not (Test-Path (Join-Path $CloneTo '.git'))) {
    if (-not (Test-Path $CloneTo)) { New-Item -ItemType Directory -Path $CloneTo -Force | Out-Null }
    Add-Step 'clone' '..' ('clone 到 ' + $CloneTo)
    $r = Invoke-Cmd 'git' @('clone', '--depth', '1', '--branch', $Branch, $Remote, $CloneTo)
    if ($r.code -ne 0) { Add-Step 'clone' 'FAIL' (($r.text -split "`n" | Select-Object -Last 2) -join ' '); Finish 1 }
    $Repo = $CloneTo
    Add-Step 'clone' 'OK' '已 clone（--depth 1）'
} elseif (Test-Path (Join-Path $Repo '.git')) {
    Add-Step 'repo' 'OK' $Repo
} else {
    Add-Step 'repo' 'FAIL' ('不是 git 仓库: ' + $Repo)
    Finish 1
}

# ── 3 部署前置：目录可写（第一次装时 ProgramData\anc 可能还不存在）────────
$rootProbe = Join-Path $env:ProgramData 'anc'
if (Test-Path $rootProbe) { Add-Step 'root' 'OK' ('已存在 ' + $rootProbe + '（重装/升级的话先看 preflight 的 already-installed）') }
else { Add-Step 'root' 'SKIP' ('还没建 ' + $rootProbe + '，由 install-company 建') }

Finish 0
