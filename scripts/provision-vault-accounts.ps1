# 按名单开「只读共享账号」：每人一个本地账号，只用于读 vault 共享，不给管理员
# 用法：
#   1) 准备 CSV（UTF-8，无 BOM 亦可）：name,id
#        张三,zhangsan
#        李四,lisi
#   2) powershell -ExecutionPolicy Bypass -File scripts\provision-vault-accounts.ps1 -Csv .\team.csv -DryRun
#   3) 去掉 -DryRun 正式执行；凭据写到 %ProgramData%\anc\accounts\provisioned-<日期>.csv
# 说明：
#   - 账号名固定 anc-read-<id>，随机 12 位密码，密码永不过期；
#   - 加入本地组 anc-vault-readers（不存在则建），不在 Administrators；
#   - 「拒绝本地登录」需在本地安全策略里对组 anc-vault-readers 单独设置（脚本不代替，避免锁死本机）；
#     脚本只保证账号进了这个组，策略才管得到它；
#   - 幂等：已存在的账号跳过，不改密码。

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Csv,
    [string]$VaultShared = 'D:\anc\vault-shared',
    [string]$Prefix = 'anc-read-',
    [string]$OutDir = "$env:ProgramData\anc\accounts",
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

function New-Password {
    $chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%'
    $rnd = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $bytes = New-Object byte[] 12
    $rnd.GetBytes($bytes)
    -join ($bytes | ForEach-Object { $chars[$_ % $chars.Length] })
}

if (-not (Test-Path $Csv)) { Write-Host "ERROR 找不到名单: $Csv"; exit 2 }
# PowerShell 5.1 的 Import-Csv 默认按 ANSI 读，中文姓名会乱码；显式 UTF8
$rows = Import-Csv -Path $Csv -Encoding UTF8
if (-not $rows) { Write-Host 'ERROR 名单为空'; exit 2 }

$plan = @()
foreach ($r in $rows) {
    $name = ($r.name, $r.Name | Where-Object { $_ }) | Select-Object -First 1
    $id = ($r.id, $r.Id | Where-Object { $_ }) | Select-Object -First 1
    if (-not $id) { Write-Host "WARN 跳过没有 id 的行: $($r | ConvertTo-Json -Compress)"; continue }
    if ($id -notmatch '^[a-z0-9][a-z0-9._-]{1,20}$') { Write-Host "WARN id 不合规（只允许小写字母数字 . _ -）: $id"; continue }
    $plan += [pscustomobject]@{ name = $name; id = $id; user = ($Prefix + $id) }
}

if (-not $plan) { Write-Host 'ERROR 名单里没有可用行'; exit 2 }

$Group = 'anc-vault-readers'
if (-not $DryRun) {
    if (-not (Get-LocalGroup -Name $Group -ErrorAction SilentlyContinue)) {
        New-LocalGroup -Name $Group -Description 'ANC vault 只读共享账号（拒绝本地登录策略作用于此组）' | Out-Null
        Write-Host "created group $Group"

    # vault 共享区：整组只读（RX）。写权限一律不给——共享账号只用来拉资料
    if (Test-Path $VaultShared) {
        & icacls $VaultShared /grant:r ($Group + ':(OI)(CI)RX') | Out-Null
        if ($LASTEXITCODE -ne 0) { Write-Host "WARN 给 $Group 授 $VaultShared 读权限失败（icacls=$LASTEXITCODE）" }
        else { Write-Host "granted $Group RX on $VaultShared" }
    } else {
        Write-Host "WARN 共享区不存在，跳过授权: $VaultShared"
    }

    # 拒绝本地登录：安全策略里没有 cmdlet，只能 secedit 导出 → 改 → 导入。
    # Deny 优先于 Allow，所以组员即便在 Users 组里也进不了桌面。
    try {
        $sid = (Get-LocalGroup -Name $Group).SID.Value
        $inf = Join-Path $env:TEMP ('anc-secpol-' + [guid]::NewGuid().ToString('N') + '.inf')
        & secedit /export /cfg $inf /areas USER_RIGHTS | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "secedit export exit=$LASTEXITCODE" }
        $txt = [IO.File]::ReadAllText($inf, [Text.Encoding]::Unicode)
        if ($txt -notmatch 'SeDenyInteractiveLogonRight') {
            $txt = $txt -replace '(\[Privilege Rights\])', ("`$1`r`nSeDenyInteractiveLogonRight = " + $sid)
        } elseif ($txt -match 'SeDenyInteractiveLogonRight\s*=\s*([^\r\n]*)') {
            if ($Matches[1] -notlike ('*' + $sid + '*')) {
                $txt = $txt.Replace($Matches[0], $Matches[0].TrimEnd() + ',' + $sid)
            }
        }
        [IO.File]::WriteAllText($inf, $txt, [Text.Encoding]::Unicode)
        & secedit /configure /db (Join-Path $env:TEMP 'anc-secpol.sdb') /cfg $inf /areas USER_RIGHTS | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "secedit configure exit=$LASTEXITCODE" }
        Write-Host "deny interactive logon: $Group ($sid)"
        Remove-Item $inf -Force -ErrorAction SilentlyContinue
    } catch {
        Write-Host ("WARN 设置拒绝本地登录失败: " + $_.Exception.Message)
        Write-Host 'WARN 共享账号仍可能登录桌面；手工用 secpol.msc 把 anc-vault-readers 加进「拒绝本地登录」'
    }
    }
    # 凭据目录先收紧再写文件：新建目录会继承 ProgramData 的默认 ACL（Users 可读）
    New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
    & icacls $OutDir /inheritance:r /grant:r 'Administrators:(OI)(CI)F' 'SYSTEM:(OI)(CI)F' | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Host "ERROR 收紧 $OutDir 权限失败（icacls 退出码 $LASTEXITCODE），不写凭据"; exit 2 }
}

$created = @()
foreach ($p in $plan) {
    $exists = [bool](Get-LocalUser -Name $p.user -ErrorAction SilentlyContinue)
    if ($DryRun) {
        Write-Host ($(if ($exists) { "dry-run 已存在（确保在 $Group 组）: " } else { "dry-run 将创建并加入 ${Group}: " }) + $p.user + " (" + $p.name + ")")
        continue
    }
    if ($exists) {
        # 旧版脚本开的账号没进组：补上（幂等），不改密码
        Add-LocalGroupMember -Group $Group -Member $p.user -ErrorAction SilentlyContinue
        Write-Host ("skip 已存在（已确保在 $Group）: " + $p.user)
        continue
    }
    $pwd = New-Password
    New-LocalUser -Name $p.user -Password (ConvertTo-SecureString $pwd -AsPlainText -Force) -Description ("ANC vault read-only: " + $p.name) -PasswordNeverExpires | Out-Null
    Add-LocalGroupMember -Group $Group -Member $p.user
    $created += [pscustomobject]@{ name = $p.name; id = $p.id; user = $p.user; password = $pwd }
    Write-Host ("created " + $p.user + " (" + $p.name + ")")
}

if ($created.Count -gt 0) {
    $file = Join-Path $OutDir ("provisioned-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + ".csv")
    $created | Export-Csv -Path $file -NoTypeInformation -Encoding UTF8
    # 凭据只给管理员与 SYSTEM：bot 账号（标准用户）不得读取；目录已先收紧，这里再对文件确认一次
    & icacls $file /inheritance:r /grant:r 'Administrators:F' 'SYSTEM:F' | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Host "ERROR 收紧凭据文件权限失败，立即删除: $file"; Remove-Item -LiteralPath $file -Force; exit 2 }
    Write-Host ("凭据已写入: " + $file)
    Write-Host '提醒：把凭据发到本人手上后删除该文件；不要提交进仓库。'
}
exit 0
