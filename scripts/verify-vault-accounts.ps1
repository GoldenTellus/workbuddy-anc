# 共享账号验收：读通 / 写拒 / 不能登录桌面 / 非管理员
# 输入是 provision-vault-accounts.ps1 生成的凭据 CSV（含明文密码，用完请删）。
# 输出一份 JSON 验收报告，作为上线证据留在 %ProgramData%\anc\accounts\。
# 退出码：0 全部通过 / 1 有失败项 / 2 前置不满足
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Csv,
    [string]$VaultShared = 'D:\anc\vault-shared',
    [string]$Group = 'anc-vault-readers',
    [string]$OutDir = "$env:ProgramData\anc\accounts",
    [string]$ProbeFile = ''
)

$ErrorActionPreference = 'Continue'

function Fail([string]$msg, [string]$fix, [int]$code) {
    Write-Host "ERROR $msg"
    Write-Host "FIX   $fix"
    exit $code
}

if (-not (Test-Path $Csv)) { Fail "找不到凭据 CSV: $Csv" '先跑 provision-vault-accounts.ps1 生成' 2 }
if (-not (Test-Path $VaultShared)) { Fail "共享区不存在: $VaultShared" '确认 -VaultShared，或先建 vault' 2 }
if (-not (Get-LocalGroup -Name $Group -ErrorAction SilentlyContinue)) {
    Fail "没有 $Group 组" '先跑 provision-vault-accounts.ps1' 2
}

# 探针文件：优先用调用方指定，否则在共享区里找一个当前账号能读的 md
if (-not $ProbeFile) {
    $ProbeFile = Get-ChildItem $VaultShared -Filter '*.md' -File -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $ProbeFile) {
    # 共享区根下没有任何 md：用目录列举当探针（RX 也允许列目录）
    $ProbeFile = $VaultShared
}

$rows = Import-Csv -Path $Csv -Encoding UTF8
if (-not $rows) { Fail '凭据 CSV 为空' '重新生成' 2 }

# 组 SID 是否在「拒绝本地登录」里
$denyHasGroup = $false
$groupSid = (Get-LocalGroup -Name $Group).SID.Value
$inf = Join-Path $env:TEMP ('anc-verify-secpol-' + [guid]::NewGuid().ToString('N') + '.inf')
& secedit /export /cfg $inf /areas USER_RIGHTS 2>&1 | Out-Null
if (Test-Path $inf) {
    $txt = [IO.File]::ReadAllText($inf, [Text.Encoding]::Unicode)
    if ($txt -match 'SeDenyInteractiveLogonRight\s*=\s*([^\r\n]*)') {
        $denyHasGroup = ($Matches[1] -split ',') -contains $groupSid
    }
    Remove-Item $inf -Force -ErrorAction SilentlyContinue
}

$results = @()
foreach ($r in $rows) {
    $user = [string]$r.user
    $pwd = [string]$r.password
    $acc = [pscustomobject]@{
        user       = $user
        name       = [string]$r.name
        exists     = $false
        inGroup    = $false
        isAdmin    = $false
        canRead    = $false
        canWrite   = $false
        denyLogon  = $denyHasGroup
        notes      = @()
    }

    if (-not (Get-LocalUser -Name $user -ErrorAction SilentlyContinue)) {
        $acc.notes += '账号不存在'
        $results += $acc
        continue
    }
    $acc.exists = $true
    $acc.inGroup = [bool](Get-LocalGroupMember -Group $Group -ErrorAction SilentlyContinue | Where-Object { ($_.Name -split '\\')[-1] -ieq $user })
    $acc.isAdmin = [bool](Get-LocalGroupMember -Group 'Administrators' -ErrorAction SilentlyContinue | Where-Object { ($_.Name -split '\\')[-1] -ieq $user })

    if (-not $pwd) {
        $acc.notes += 'CSV 里没有密码，跳过读/写实测'
        $results += $acc
        continue
    }

    $sec = ConvertTo-SecureString $pwd -AsPlainText -Force
    $cred = New-Object System.Management.Automation.PSCredential($user, $sec)

    # 读：列出/读取探针，退出码 0 即通过
    $readArgs = @('/c', 'type', ('"' + $ProbeFile + '"'))
    if ($ProbeFile -eq $VaultShared) { $readArgs = @('/c', 'dir', ('"' + $VaultShared + '"')) }
    try {
        $p1 = Start-Process -FilePath 'cmd.exe' -ArgumentList $readArgs -Credential $cred -Wait -PassThru -WindowStyle Hidden 2>$null
        $acc.canRead = ($p1.ExitCode -eq 0)
        if (-not $acc.canRead) { $acc.notes += ('读失败 exit=' + $p1.ExitCode) }
    } catch {
        $acc.notes += ('无法以该身份执行（seclogon/Secondary Logon 服务？）: ' + $_.Exception.Message)
    }

    # 写：应被拒（非 0 退出码）
    $probe = Join-Path $VaultShared ('.anc-write-test-' + $user + '.tmp')
    try {
        $p2 = Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', 'echo', 'x', '>', ('"' + $probe + '"')) -Credential $cred -Wait -PassThru -WindowStyle Hidden 2>$null
        $acc.canWrite = ($p2.ExitCode -eq 0) -and (Test-Path $probe)
        if ($acc.canWrite) { Remove-Item $probe -Force -ErrorAction SilentlyContinue }
    } catch {
        $acc.notes += ('写测试无法执行: ' + $_.Exception.Message)
    }

    $results += $acc
}

# 判定：在读通、写拒、非管理员、（组级）拒绝本地登录 四项都成立才算通过
$bad = @($results | Where-Object { -not $_.exists -or -not $_.inGroup -or $_.isAdmin -or -not $_.canRead -or $_.canWrite -or -not $_.denyLogon })

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
$report = Join-Path $OutDir ('verify-' + $stamp + '.json')
[pscustomobject]@{
    at          = (Get-Date).ToString('o')
    vault       = $VaultShared
    group       = $Group
    groupSid    = $groupSid
    denyLogon   = $denyHasGroup
    probe       = $ProbeFile
    total       = $results.Count
    failed      = $bad.Count
    accounts    = $results
} | ConvertTo-Json -Depth 6 | Set-Content $report -Encoding utf8

Write-Host ('[verify] ' + $results.Count + ' 个账号，失败 ' + $bad.Count + ' 个')
foreach ($a in $results) {
    $flag = if ($bad -contains $a) { 'FAIL' } else { 'PASS' }
    Write-Host ("  {0} {1,-24} 读={2} 写={3} 管理员={4} 拒绝登录={5}" -f $flag, $a.user, $a.canRead, $a.canWrite, $a.isAdmin, $a.denyLogon)
    foreach ($n in $a.notes) { Write-Host ('       ' + $n) }
}
Write-Host ('report: ' + $report)

if (-not $denyHasGroup) {
    Write-Host "WARN $Group 不在「拒绝本地登录」里：重跑 provision，或用 secpol.msc 手工加"
}
if ($bad.Count -gt 0) { exit 1 } else { exit 0 }
