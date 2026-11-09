# 每天 03:00 自动创建新 host 对话。需要 wake bridge + wb-wake.flag + workspace 文件。
# 失败不硬切：anc-executor-host-tick 会把旧 host 标 deferred，继续接单。
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:ProgramData 'anc'
$db = Join-Path $root 'data\anc.db'
$node = 'C:\Program Files\nodejs\node.exe'
$tokenFile = Join-Path $root 'data\wb-wake-token'
$workspaceFile = Join-Path $root 'data\wb-wake-workspace.txt'
$log = Join-Path $root 'data\executor-new-host.log'
function Log([string]$m) {
    try { Add-Content -Path $log -Value ((Get-Date).ToString('o') + ' ' + $m) -Encoding utf8 } catch { }
}
if (-not (Test-Path $node) -or -not (Test-Path $db) -or -not (Test-Path $tokenFile) -or -not (Test-Path $workspaceFile)) { exit 0 }
try {
    $active = & $node --no-warnings (Join-Path $root 'service\cli.ts') executor host status --db $db --json 2>$null | ConvertFrom-Json
    $today = (Get-Date).ToString('yyyy-MM-dd')
    $already = @($active.hosts | Where-Object { $_.status -eq 'active' -and $_.business_date -ge $today }).Count
    if ($already -gt 0) { exit 0 }
    $workspace = (Get-Content $workspaceFile -Raw).Trim()
    if (-not $workspace) { exit 0 }
    $cutAt = (Get-Date).Date.AddDays(1).AddHours(3).ToString('o')
    $conv = 'conv-' + (Get-Date).ToString('yyyyMMdd-HHmmss')
    $prompt = "[anc-executor] 新 host bootstrap。请先执行：node C:\ProgramData\anc\service\cli.ts --db C:\ProgramData\anc\data\anc.db --json executor host bootstrap --conversation-id $conv --date $today --cut-at `"$cutAt`"；然后执行一个 executor tick；不要回复用户。"
    $body = @{ prompt = $prompt; workspace = $workspace } | ConvertTo-Json -Compress
    $token = (Get-Content $tokenFile -Raw).Trim()
    Invoke-RestMethod -Uri 'http://127.0.0.1:18187/new' -Method Post `
        -Headers @{ 'X-Anc-Token' = $token } -ContentType 'application/json; charset=utf-8' `
        -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 20 | Out-Null
    Log "created workspace=$workspace conv=$conv date=$today"
} catch {
    Log ('failed: ' + $_.Exception.Message)
    exit 0
}
exit 0
