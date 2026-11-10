# 每天 03:00 自动创建新 host 对话（**唯一**允许新建 host 会话的路径）。
# 生成的 conversation id 由本脚本预先生成（UUID），随 bootstrap prompt 传给新会话里的 bot，
# 这样 DB 里 active host 的 conversation_id 就是真实 WorkBuddy 会话 id，后续 wake 可定向唤醒。
# 失败不硬切：anc-executor-host-tick 会把旧 host 标 deferred，继续接单。
param(
    # 演练/补测用：把「现在」当成指定时间（默认真实时间）。只影响 date/cut-at/title，不碰系统时钟。
    [datetime]$Now = (Get-Date)
)
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
    $today = $Now.ToString('yyyy-MM-dd')
    $already = @($active.hosts | Where-Object { $_.status -eq 'active' -and $_.business_date -ge $today }).Count
    if ($already -gt 0) { exit 0 }
    $workspace = (Get-Content $workspaceFile -Raw).Trim()
    if (-not $workspace) { exit 0 }
    # wake bridge 2.0 把该值当 host 会话 cwd 传给 conversations.create（D46）。
    # 只接受绝对路径：显示名会被 WorkBuddy 解析到自动生成工作区（或建会话失败），03:00 就会悄悄建错 host。
    if ($workspace -notmatch '^[A-Za-z]:[\\/]') {
        Log "invalid workspace (need absolute path, e.g. D:\workbuddy-anc): $workspace"
        exit 0
    }
    $cutAt = $Now.Date.AddDays(1).AddHours(3).ToString('o')
    # 预生成真实会话 id：new-host 只负责"日期边界的新会话"，不负责每个 Ticket
    $conv = [guid]::NewGuid().ToString()
    $title = 'anc-host-' + $today
    $prompt = "[anc-executor] 新 host bootstrap。请先执行：node C:\ProgramData\anc\service\cli.ts --db C:\ProgramData\anc\data\anc.db --json executor host bootstrap --conversation-id $conv --date $today --cut-at `"$cutAt`"；然后执行一个 executor tick；不要回复用户。"
    $body = @{ prompt = $prompt; workspace = $workspace; conversationId = $conv; title = $title } | ConvertTo-Json -Compress
    $token = (Get-Content $tokenFile -Raw).Trim()
    $r = Invoke-RestMethod -Uri 'http://127.0.0.1:18187/new' -Method Post `
        -Headers @{ 'X-Anc-Token' = $token } -ContentType 'application/json; charset=utf-8' `
        -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 30
    if (-not $r.ok) { Log "failed: bridge ok=false error=$($r.error)"; exit 0 }
    Log "created workspace=$workspace conv=$($r.conversationId) requested=$conv title=$title date=$today via=$($r.via)"
} catch {
    Log ('failed: ' + $_.Exception.Message)
    exit 0
}
exit 0
