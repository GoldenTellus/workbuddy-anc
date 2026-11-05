# 离职收口：把一个人的 bot 身份、在办任务、群绑定一起处理掉
# 默认 dry-run；加 -Apply 才动。**不删数据**：persona 产物被清、任务转交、绑定解绑，
# 但 vault 里的档案与入库记录原样保留（D21：复核保留，离职也一样）。
#
# 前置：先在 org/members/<id>.md 里手工加一行 `disabled: true`（本脚本不改 org，
# 改 org 是内容变更，应该走人来看）。
#
# 用法：
#   powershell -File offboard-member.ps1 -MemberId zhangsan -FromUserid <openid> -ToUserid <openid> -ToName 王五
#   powershell -File offboard-member.ps1 ... -Apply
#   powershell -File offboard-member.ps1 ... -Apply -DeleteAccount -AccountName <Windows 账号名>
# 退出码：0 成功 / 1 有步骤失败 / 2 用法或前置不满足
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$MemberId,
    [string]$FromUserid = '',
    [string]$ToUserid = '',
    [string]$ToName = '',
    [string]$ChatId = '',
    [string]$OrgDir = 'D:\anc\org',
    [string]$OutDir = 'D:\anc\build',
    [string]$AccountName = '',
    [switch]$DeleteAccount,
    [switch]$Apply
)

$ErrorActionPreference = 'Stop'
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = 'C:\Program Files\nodejs\node.exe' }

function Fail([string]$msg, [string]$fix, [int]$code) {
    Write-Host "ERROR $msg"
    Write-Host "FIX   $fix"
    exit $code
}

function Get-Frontmatter([string]$file) {
    $fm = @{}
    if (-not (Test-Path $file)) { return $fm }
    $seen = 0
    foreach ($l in (Get-Content $file -Encoding UTF8)) {
        if ($l.Trim() -eq '---') { $seen++; if ($seen -ge 2) { break } else { continue } }
        if ($l -match '^\s*([A-Za-z0-9_.-]+)\s*:\s*(.*)$') { $fm[$Matches[1]] = $Matches[2].Trim() }
    }
    return $fm
}

$memberFile = Join-Path (Join-Path $OrgDir 'members') ($MemberId + '.md')
if (-not (Test-Path $memberFile)) { Fail "找不到成员文件: $memberFile" '确认 -MemberId 与 -OrgDir' 2 }

$fm = Get-Frontmatter $memberFile
if ($fm['disabled'] -ne 'true') {
    Fail "$MemberId 还没标停用（$memberFile 里没有 disabled: true）" '先手工在 frontmatter 加 disabled: true，再跑本脚本' 2
}
if (-not $FromUserid) { $FromUserid = [string]$fm['userid'] }
if (-not $ChatId) { $ChatId = [string]$fm['chat_id'] }
if (-not $ToUserid -and -not $ToName) { Fail '缺少 -ToUserid 或 -ToName' '任务要有新归属，或明确不转交时传 -SkipReassign' 2 }

'dry-run' | Out-Null
$steps = @()
$steps += "1) 重新渲染：清掉 members/$MemberId 产物，并从 groups.json 移除"
if ($ToUserid -or $ToName) { $steps += "2) 转交 open 任务：$FromUserid -> $(if ($ToUserid) { $ToUserid } else { $ToName })" }
if ($ChatId) { $steps += "3) 解绑群：$ChatId" }
if ($DeleteAccount) {
    if (-not $AccountName) { Fail '开了 -DeleteAccount 但没给 -AccountName' 'Windows 账号名不一定等于 member id，显式传' 2 }
    $steps += "4) 删除 Windows 账号：$AccountName（不可逆）"
}

Write-Host ("[offboard] " + $MemberId + "  " + $(if ($Apply) { 'APPLY' } else { 'DRY-RUN' }))
foreach ($s in $steps) { Write-Host ("  " + $s) }

if (-not $Apply) { Write-Host 'dry-run：加 -Apply 才动'; exit 0 }

$failed = @()

# 1) 重新渲染（deployOrg 会清掉停用成员的产物，并对拍）
Write-Host '[1/4] 重渲染 ...'
# node 24 的 `ExperimentalWarning: SQLite` 会走 stderr。原来这两处是 `& $node --no-warnings ... 2>&1 | Out-String`，
# 而本脚本 $ErrorActionPreference = Stop —— warning 被 `2>&1` 抓成"输出"后触发终止，
# 表现是「[1/4] 成功、[4/4] 没执行、账号没删」而且没有任何错误指向真因（2026-11-04 踩到）。
# 所以所有 node 调用都带 --no-warnings。别删。
$renderOut = & $node --no-warnings 'C:\ProgramData\anc\render\cli.ts' deploy --org $OrgDir --out $OutDir --json 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) { $failed += ('render: ' + $renderOut.Trim()) }
else { Write-Host ('      ' + $renderOut.Trim()) }

# 2) 转交任务
if ($ToUserid -or $ToName) {
    Write-Host '[2/4] 转交任务 ...'
    $cliArgs = @('--no-warnings', 'C:\ProgramData\anc\service\cli.ts', '--db', "$env:ProgramData\anc\data\anc.db", 'task', 'reassign', '--from', $FromUserid)
    if ($ToUserid) { $cliArgs += @('--to', $ToUserid) }
    if ($ToName) { $cliArgs += @('--to-name', $ToName) }
    $cliArgs += @('--actor', 'offboard')
    $re = & $node --no-warnings @cliArgs 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) { $failed += ('reassign: ' + $re.Trim()) } else { Write-Host ('      ' + $re.Trim()) }
}

# 3) 解绑群
if ($ChatId) {
    Write-Host '[3/4] 解绑群 ...'
    $ub = & $node --no-warnings 'C:\ProgramData\anc\service\cli.ts' --db "$env:ProgramData\anc\data\anc.db" bind unbind --chat-id $ChatId 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) { $failed += ('unbind: ' + $ub.Trim()) } else { Write-Host ('      ' + $ub.Trim()) }
}

# 4) 删账号（默认不做）
if ($DeleteAccount) {
    Write-Host '[4/4] 删除 Windows 账号 ...'
    try {
        Remove-LocalUser -Name $AccountName -ErrorAction Stop
        Write-Host "      已删除 $AccountName"
    } catch {
        $failed += ('Remove-LocalUser: ' + $_.Exception.Message)
    }
}

if ($failed.Count -gt 0) {
    Write-Host ''
    foreach ($f in $failed) { Write-Host ('FAIL ' + $f) }
    Write-Host 'FIX   按上面失败的步骤单独处理；已完成的部分不会回滚'
    exit 1
}
Write-Host '[offboard] 完成。vault 里的档案与入库记录未动（D21 复核保留）。'
exit 0
