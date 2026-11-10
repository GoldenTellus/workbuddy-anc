# 建 vault 两区：目录、模板、git、ACL、SMB 共享、HTTP 面 token。
#
# 为什么要脚本化：
#   这段以前是手册里的 30 行命令，顺序和参数都有讲究，抄错一步就是「装完了，但入库写不进去」
#   或者「共享区谁都能改」。下面每一条都有踩过的原因，不是照抄文档。
#
# 顺序不能乱：
#   1. 建目录      —— 后面每一步都要用
#   2. 铺模板      —— 必须在 git init 之前，模板才能进首次提交
#   3. git init    —— 两区必须是**独立** git 目录（A2A 要求），不能是父子关系
#   4. ACL         —— 断继承会连 Administrators/SYSTEM 一起砍掉，必须同一条命令补回
#   5. SMB         —— 共享层 + NTFS 层叠加才是「全员只读」
#   6. token       —— 生成后必须重跑 set-acl，否则新文件不继承 secrets 的 ACE
#
# 幂等：目录/仓库/模板已存在就跳过；SMB 存在则校正权限；token **已存在就保留**
#       （换了 token，正在跑的 anc-http 会全部 401）。
#
# 用法：
#   vault-init.ps1 -VaultRoot D:\anc                    # 预演（默认 dry-run）
#   vault-init.ps1 -VaultRoot D:\anc -Apply             # 落盘（要管理员）
#   vault-init.ps1 -VaultRoot D:\anc -Apply -Json
#
# 退出码：0 成功（含"已经就绪、无需改动"）/ 1 校验失败 / 2 用法或环境错误

[CmdletBinding()]
param(
    [string]$VaultRoot = 'D:\anc',
    [string]$Root = '',
    [switch]$Apply,
    [switch]$Json
)

$ErrorActionPreference = 'Stop'

if (-not $Root) { $Root = Join-Path $env:ProgramData 'anc' }
$shared = Join-Path $VaultRoot 'vault-shared'
$internal = Join-Path $VaultRoot 'vault-internal'
$steps = @()
$out = [ordered]@{ ok = $false; vaultRoot = $VaultRoot; shared = $shared; internal = $internal; steps = @(); next = '' }

function Add-Step([string]$name, [string]$state, [string]$detail) {
    $script:steps += [pscustomobject]@{ step = $name; state = $state; detail = $detail }
}

function Finish([int]$code) {
    $out.steps = @($script:steps)
    $out.ok = ($code -eq 0)
    if ($Json) {
        try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
        $out | ConvertTo-Json -Depth 6
    } else {
        foreach ($s in $script:steps) {
            $mark = switch ($s.state) { 'OK' { '  ok ' } 'SKIP' { ' skip' } 'FAIL' { ' FAIL' } default { '  .. ' } }
            Write-Output ($mark + ' ' + $s.step + '  ' + $s.detail)
        }
        Write-Output ''
        if ($out.next) { Write-Output ('NEXT  ' + $out.next) }
    }
    exit $code
}

function Fail([string]$msg, [string]$fix, [int]$code = 1) {
    Add-Step 'abort' 'FAIL' $msg
    $out.next = $fix
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

# ── 环境 ────────────────────────────────────────────────────────────────────
$isAdmin = $false
try {
    $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
} catch { }
# 只有真正落盘才要求管理员：预演（dry-run）是只读的，标准用户也能看计划
if ($Apply -and -not $isAdmin) {
    Fail '要管理员权限（建共享、改 ACL、写 secrets）' '用管理员身份打开 WorkBuddy（或管理员 PowerShell）再跑；preflight 的 agent-elevated 就是拦这个' 2
}
if (-not (Test-Path $VaultRoot)) {
    $q = try { Split-Path -Qualifier $VaultRoot } catch { '' }
    if (-not $q -or -not (Test-Path ($q + '\'))) { Fail "vault 盘不存在: $VaultRoot" '换一块存在的盘，或用 -VaultRoot 指过去' 2 }
    if ($Apply) { New-Item -ItemType Directory -Path $VaultRoot -Force | Out-Null }
}
if ((Test-Path $shared) -and (Test-Path $internal)) {
    try {
        if ((Resolve-Path $shared).Path -eq (Resolve-Path $internal).Path) {
            Fail '共享区和内部区是同一个目录' '它们必须是两个独立 git 目录；换一个 -VaultRoot 下的布局' 2
        }
    } catch { }
}

Add-Step 'env' 'OK' ("管理员=" + $isAdmin + "，vault=" + $VaultRoot)

# ── 1 目录 ──────────────────────────────────────────────────────────────────
$dirs = @($shared, $internal, (Join-Path $internal 'collab'), (Join-Path $shared 'company'), (Join-Path $shared '_originals'))
foreach ($d in $dirs) {
    if (Test-Path $d) { continue }
    if ($Apply) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
}
Add-Step 'dirs' 'OK' '两区 + collab + company + _originals'

# ── 2 模板（必须在 git init 之前）──────────────────────────────────────────
$tpl = Join-Path $Root 'light\templates\vault'
if (Test-Path $tpl) {
    $pairs = @(
        @{ Src = (Join-Path $tpl 'collab'); Dst = (Join-Path $internal 'collab') },
        @{ Src = (Join-Path $tpl 'company'); Dst = (Join-Path $shared 'company') }
    )
    $copied = 0
    foreach ($p in $pairs) {
        if (-not (Test-Path $p.Src)) { continue }
        foreach ($f in @(Get-ChildItem $p.Src -File -Filter '*.md')) {
            $dst = Join-Path $p.Dst $f.Name
            if (Test-Path $dst) { continue }
            if ($Apply) { Copy-Item $f.FullName $dst -Force }
            $copied++
        }
    }
    Add-Step 'templates' 'OK' ("铺了 $copied 份模板（已存在的不覆盖）")
} else {
    Add-Step 'templates' 'SKIP' ('没有 ' + $tpl + '，先跑 deploy.ps1 -Apply；本次跳过铺模板')
}

# ── 3 git（两区各自独立）───────────────────────────────────────────────────
foreach ($pair in @(@{ Name = 'vault-shared'; Path = $shared }, @{ Name = 'vault-internal'; Path = $internal })) {
    $p = $pair.Path
    if (Test-Path (Join-Path $p '.git')) { Add-Step ('git:' + $pair.Name) 'SKIP' '已是 git 仓库'; continue }
    if (-not $Apply) { Add-Step ('git:' + $pair.Name) 'OK' '(dry) 会 init'; continue }
    # .gitignore：原件不进 git（D14）
    $gi = Join-Path $p '.gitignore'
    if (-not (Test-Path $gi)) { [IO.File]::WriteAllText($gi, "_originals/`n", (New-Object Text.UTF8Encoding($false))) }
    $rd = Join-Path $p 'README.md'
    if (-not (Test-Path $rd)) { [IO.File]::WriteAllText($rd, ('# ' + $pair.Name + "`n"), (New-Object Text.UTF8Encoding($false))) }
    $r = Invoke-Cmd 'git' @('-C', $p, 'init', '-q')
    if ($r.code -ne 0) { Fail ('git init 失败: ' + $pair.Name) ($r.text + '；确认装了 Git for Windows') 1 }
    $null = Invoke-Cmd 'git' @('-C', $p, 'add', '-A')
    $c = Invoke-Cmd 'git' @('-C', $p, '-c', 'user.name=anc', '-c', 'user.email=anc@localhost', 'commit', '-q', '-m', 'init')
    Add-Step ('git:' + $pair.Name) 'OK' $(if ($c.code -eq 0) { 'init + 首次提交' } else { 'init（无内容可提交）' })
}

# ── 4 ACL ──────────────────────────────────────────────────────────────────
# shared：全员只读。必须 /inheritance:r 断继承——/grant:r 改不动继承来的那条
# （父目录一般给 Authenticated Users Modify，那等于谁都能改共享区，doctor 的 vault-acl 会 FAIL）。
# 断继承会一起砍掉 SYSTEM / Administrators，所以同一条命令里补回来。
if ($Apply) {
    $r1 = Invoke-Cmd 'icacls' @($shared, '/inheritance:r',
        '/grant:r', 'SYSTEM:(OI)(CI)F', 'BUILTIN\Administrators:(OI)(CI)F',
        'NT AUTHORITY\Authenticated Users:(OI)(CI)RX', 'BUILTIN\Users:(OI)(CI)RX')
    if ($r1.code -ne 0) { Fail ('共享区 ACL 设置失败: ' + $shared) $r1.text 1 }
    Add-Step 'acl:shared' 'OK' 'SYSTEM/Administrators 完全控制，Authenticated Users/Users 只读'

    # internal：只有公司侧。普通用户与 Authenticated Users 一律不进
    $r2 = Invoke-Cmd 'icacls' @($internal, '/inheritance:r',
        '/grant:r', 'SYSTEM:(OI)(CI)F', 'BUILTIN\Administrators:(OI)(CI)F', ($env:USERNAME + ':(OI)(CI)F'))
    if ($r2.code -ne 0) { Fail ('内部区 ACL 设置失败: ' + $internal) $r2.text 1 }
    Add-Step 'acl:internal' 'OK' ('SYSTEM/Administrators/' + $env:USERNAME + ' 完全控制')
} else {
    Add-Step 'acl' 'OK' '(dry) 会断继承并重设两区 ACL'
}

# ── 5 SMB 共享 ─────────────────────────────────────────────────────────────
$shareName = 'anc-vault-shared'
if ($Apply) {
    $existing = Get-SmbShare -Name $shareName -ErrorAction SilentlyContinue
    if ($existing) {
        # 存在则校正权限：先清掉非预期的，再补两条
        try {
            Get-SmbShareAccess -Name $shareName -ErrorAction SilentlyContinue |
                ForEach-Object { Revoke-SmbShareAccess -Name $shareName -AccountName $_.AccountName -Force -ErrorAction SilentlyContinue | Out-Null }
            Grant-SmbShareAccess -Name $shareName -AccountName 'BUILTIN\Administrators' -AccessRight Full -Force | Out-Null
            Grant-SmbShareAccess -Name $shareName -AccountName 'Authenticated Users' -AccessRight Read -Force | Out-Null
            Add-Step 'smb' 'OK' '已存在，权限已校正为 Administrators=Full / Authenticated Users=Read'
        } catch {
            Add-Step 'smb' 'FAIL' ('共享已存在但校正权限失败: ' + $_.Exception.Message)
        }
    } else {
        try {
            New-SmbShare -Name $shareName -Path $shared -FullAccess 'BUILTIN\Administrators' -ReadAccess 'Authenticated Users' | Out-Null
            Add-Step 'smb' 'OK' ('已建共享 ' + $shareName + ' -> ' + $shared)
        } catch {
            Fail ('建共享失败: ' + $_.Exception.Message) '确认 SMB 服务在跑（Get-Service LanmanServer）；本机策略可能禁止建共享' 1
        }
    }
} else {
    Add-Step 'smb' 'OK' '(dry) 会建/校正 ' + $shareName
}

# ── 6 HTTP 面 token ────────────────────────────────────────────────────────
$secrets = Join-Path $Root 'secrets'
$tokenFile = Join-Path $secrets 'service-token.txt'
if (Test-Path $tokenFile) {
    Add-Step 'token' 'SKIP' '已存在，保留（换 token 会让正在跑的 anc-http 全部 401）'
} elseif ($Apply) {
    if (-not (Test-Path $secrets)) { New-Item -ItemType Directory -Path $secrets -Force | Out-Null }
    $bytes = New-Object byte[] 32
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $hex = ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''
    Set-Content -Path $tokenFile -Value $hex -Encoding ASCII -NoNewline
    Add-Step 'token' 'OK' '已生成 64 位 hex'
    # 新文件不继承 secrets 的 ACE，必须重跑 set-acl
    $setAcl = Join-Path $PSScriptRoot 'set-acl.ps1'
    if (Test-Path $setAcl) {
        $sa = Invoke-Cmd 'powershell' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $setAcl, '-Root', $Root, '-Apply')
        if ($sa.code -ne 0) { Add-Step 'acl:secrets' 'FAIL' 'set-acl 失败，secrets 权限可能没收紧' } else { Add-Step 'acl:secrets' 'OK' '已重设 secrets 的 ACL' }
    } else {
        Add-Step 'acl:secrets' 'SKIP' '没有同目录的 set-acl.ps1'
    }
} else {
    Add-Step 'token' 'OK' '(dry) 会生成 64 位 hex 并重设 secrets ACL'
}

# ── 校验 ───────────────────────────────────────────────────────────────────
if ($Apply) {
    $bad = @()
    foreach ($p in @((Join-Path $shared '.git'), (Join-Path $internal '.git'), (Join-Path $internal 'collab'))) {
        if (-not (Test-Path $p)) { $bad += ('缺 ' + $p) }
    }
    if (-not (Get-SmbShare -Name $shareName -ErrorAction SilentlyContinue)) { $bad += '没有 SMB 共享' }
    if (Test-Path $tokenFile) {
        $tv = (Get-Content $tokenFile -Raw).Trim()
        if ($tv -notmatch '^[0-9a-f]{64}$') { $bad += 'service-token 不是 64 位 hex' }
    }
    if ($bad.Count -gt 0) { Fail ('vault 校验失败: ' + ($bad -join '; ')) '逐项按上面的 step 结果修；建共享/ACL 都要管理员' 1 }
    Add-Step 'verify' 'OK' '两区 git / collab / SMB / token 全部就绪'
} else {
    Add-Step 'verify' 'OK' '(dry) 未落盘'
}

$out.next = $(if ($Apply) { 'vault 就绪。接着 §10 写 org（可用 tools\org-write.ps1 自动生成），再 render + persona。' } else { '预演完成。确认无误后加 -Apply 落盘（要管理员）。' })
Finish 0
