# 按名单开「只读共享账号」：每人一个本地账号，只用于读 vault 共享，不给管理员
# 用法：
#   1) 准备 CSV（UTF-8，无 BOM 亦可）：name,id
#        张三,zhangsan
#        李四,lisi
#   2) powershell -ExecutionPolicy Bypass -File scripts\provision-vault-accounts.ps1 -Csv .\team.csv -DryRun
#   3) 去掉 -DryRun 正式执行；凭据写到 %ProgramData%\anc\accounts\provisioned-<日期>.csv
# 说明：
#   - 账号名固定 anc-read-<id>，随机 12 位密码，密码永不过期；
#   - 默认属于 Users，不在 Administrators；
#   - 「拒绝本地登录」需在本地安全策略里对组 anc-vault-readers 单独设置（脚本不代替，避免锁死本机）；
#   - 幂等：已存在的账号跳过，不改密码。

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Csv,
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
$rows = Import-Csv -Path $Csv
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

$created = @()
foreach ($p in $plan) {
    $exists = [bool](Get-LocalUser -Name $p.user -ErrorAction SilentlyContinue)
    if ($exists) { Write-Host ("skip 已存在: " + $p.user); continue }
    if ($DryRun) { Write-Host ("dry-run 将创建: " + $p.user + " (" + $p.name + ")"); continue }
    $pwd = New-Password
    New-LocalUser -Name $p.user -Password (ConvertTo-SecureString $pwd -AsPlainText -Force) -Description ("ANC vault read-only: " + $p.name) -PasswordNeverExpires | Out-Null
    $created += [pscustomobject]@{ name = $p.name; id = $p.id; user = $p.user; password = $pwd }
    Write-Host ("created " + $p.user + " (" + $p.name + ")")
}

if ($created.Count -gt 0) {
    New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
    $file = Join-Path $OutDir ("provisioned-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + ".csv")
    $created | Export-Csv -Path $file -NoTypeInformation -Encoding UTF8
    Write-Host ("凭据已写入: " + $file)
    Write-Host '提醒：把凭据发到本人手上后删除该文件；不要提交进仓库。'
}
exit 0
