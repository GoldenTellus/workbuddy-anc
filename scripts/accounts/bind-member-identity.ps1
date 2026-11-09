# 首次身份绑定：把企微 AI Bot 上报的 sender id（wo…）写进 org 成员的 userid，然后重渲染+同步。
# 由公司 bot 在「遇到未识别成员」时调用（persona / anc-task 技能）。确定性动作，不靠模型记忆。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File bind-member-identity.ps1 -Name "张三" -Userid "woXXXX"
#   powershell ... -PersonId zhangsan -Userid "woXXXX"
# 退出码：0 成功 / 1 找不到人或重名 / 2 参数/环境错误
[CmdletBinding()]
param(
    [string]$Name = '',
    [string]$PersonId = '',
    [string]$Userid = '',
    [string]$Org = 'D:\anc\org',
    [string]$Root = (Join-Path $env:ProgramData 'anc')
)
$ErrorActionPreference = 'Stop'

function Out-Fail([string]$reason, [string]$detail, [int]$code) {
    [ordered]@{ ok = $false; reason = $reason; detail = $detail } | ConvertTo-Json -Compress
    exit $code
}

if (-not $Userid -or $Userid -notmatch '^[A-Za-z0-9_-]{8,128}$') { Out-Fail 'bad-userid' 'userid 为空或格式不对' 2 }
if (-not $Name -and -not $PersonId) { Out-Fail 'bad-args' '需要 -Name 或 -PersonId' 2 }
$membersDir = Join-Path $Org 'members'
if (-not (Test-Path $membersDir)) { Out-Fail 'no-org' "找不到 $membersDir" 2 }

$found = @()
foreach ($f in @(Get-ChildItem -LiteralPath $membersDir -Filter '*.md' -File)) {
    $text = [IO.File]::ReadAllText($f.FullName, [Text.Encoding]::UTF8)
    $id = ''; $nm = ''
    foreach ($line in ($text -split "`r?`n")) {
        if ($line -match '^id:\s*(.+?)\s*$') { $id = $matches[1] }
        elseif ($line -match '^name:\s*(.+?)\s*$') { $nm = $matches[1] }
    }
    if ($PersonId -and $id -eq $PersonId) { $found += ,@{ file = $f.FullName; id = $id; name = $nm } }
    elseif (-not $PersonId -and $Name -and $nm -eq $Name) { $found += ,@{ file = $f.FullName; id = $id; name = $nm } }
}

if ($found.Count -eq 0) { Out-Fail 'person-not-found' ('org/members 里没有匹配的成员: Name=' + $Name + ' PersonId=' + $PersonId) 1 }
if ($found.Count -gt 1) {
    $ids = @($found | ForEach-Object { $_.id }) -join ','
    Out-Fail 'ambiguous' ('重名，需要管理员指定 PersonId；候选: ' + $ids) 1
}

$m = $found[0]
$text = [IO.File]::ReadAllText($m.file, [Text.Encoding]::UTF8)
$newLine = 'userid: ' + $Userid
if ($text -match '(?m)^userid:.*$') {
    $updated = [regex]::Replace($text, '(?m)^userid:.*$', $newLine)
} else {
    # 没有 userid 行：插在 name 行之后（没有 name 就插在第一个 --- 之后）
    if ($text -match '(?m)^name:.*$') {
        $updated = [regex]::Replace($text, '(?m)^(name:.*)$', "`$1`r`n$newLine", 1)
    } else {
        $updated = $text -replace '(?m)^---\r?\n', "---`r`n$newLine`r`n", 1
    }
}
[IO.File]::WriteAllText($m.file, $updated, (New-Object Text.UTF8Encoding($false)))

$render = Join-Path $Root 'render\cli.ts'
$db = Join-Path $Root 'data\anc.db'
$outDir = Join-Path $Root 'render'
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = 'C:\Program Files\nodejs\node.exe' }
$renderOut = & $node --no-warnings $render deploy --org $Org --out $outDir --db $db 2>&1 | Out-String
$renderCode = $LASTEXITCODE
if ($renderCode -ne 0) {
    [ordered]@{ ok = $false; reason = 'render-failed'; person_id = $m.id; detail = $renderOut.Trim() } | ConvertTo-Json -Compress
    exit 1
}
[ordered]@{ ok = $true; person_id = $m.id; name = $m.name; userid = $Userid; render = 'ok' } | ConvertTo-Json -Compress
exit 0