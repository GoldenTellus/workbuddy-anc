# 每分钟检查 executor 队列；只有 queued Ticket 时才唤醒**已有 active daily host**。
# 有 host 的真实 conversation_id（UUID）时定向 /wake 到该会话，不再每票新建 host；
# /new 只留给 03:00 日切（new-host.ps1）与旧部署兼容（host 没有真实会话 id 时）。
# 没有 wb-wake.flag / wake bridge 时静默退出，不碰 UI。
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:ProgramData 'anc'
$db = Join-Path $root 'data\anc.db'
$node = 'C:\Program Files\nodejs\node.exe'
$tokenFile = Join-Path $root 'data\wb-wake-token'
$workspaceFile = Join-Path $root 'data\wb-wake-workspace.txt'
$lastFile = Join-Path $root 'data\executor-wake-last.txt'
$log = Join-Path $root 'data\executor-wake.log'
function Log([string]$m) {
    try { Add-Content -Path $log -Value ((Get-Date).ToString('o') + ' ' + $m) -Encoding utf8 } catch { }
}
if (-not (Test-Path $node)) { exit 0 }
if (-not (Test-Path $db)) { exit 0 }
# 预算/过期扫描独立于 wake bridge：没有 flag/token 也要跑
try { & $node --no-warnings (Join-Path $root 'service\cli.ts') executor expire --db $db --json 2>$null | Out-Null } catch { }
# Attention 2h/8h/24h 提醒与升级：同样不依赖 wake bridge
try { & $node --no-warnings (Join-Path $root 'service\cli.ts') executor attention sweep --apply --db $db --json 2>$null | Out-Null } catch { }
if (-not (Test-Path $tokenFile)) { exit 0 }
# 60 秒节流：计划任务每分钟一次，避免重叠运行刷消息
if (Test-Path $lastFile) {
    try {
        $last = [datetime]::Parse((Get-Content $lastFile -Raw).Trim())
        if (((Get-Date) - $last).TotalSeconds -lt 45) { exit 0 }
    } catch { }
}
try {
    $queued = & $node --no-warnings (Join-Path $root 'service\cli.ts') executor ticket list --state queued --db $db --json 2>$null | ConvertFrom-Json
    $count = @($queued.tickets).Count
    if ($count -le 0) { exit 0 }
    $hosts = & $node --no-warnings (Join-Path $root 'service\cli.ts') executor host status --db $db --json 2>$null | ConvertFrom-Json
    $activeHost = @($hosts.hosts | Where-Object { $_.status -eq 'active' })[0]
    if (-not $activeHost) { exit 0 }
    $token = (Get-Content $tokenFile -Raw).Trim()
    $workspace = ''
    if (Test-Path $workspaceFile) { $workspace = (Get-Content $workspaceFile -Raw).Trim() }
    $convId = [string]$activeHost.conversation_id
    # 真实 WorkBuddy conversation id 是 UUID；旧的 conv-* 是占位 id，不能定向
    $isRealConv = $convId -match '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    $prompt = "[anc-executor] 队列有 $count 个 Ticket；active host=$($activeHost.host_id)。请只做一个 tick：executor claim --host-id $($activeHost.host_id) --limit 1；不要 host bootstrap；按 anc-executor 技能用 Agent tool 起 subagent；任务目录根是 D:\anc；没有空槽就停止；不要回复用户。"
    if ($isRealConv) {
        $body = @{ prompt = $prompt; conversationId = $convId } | ConvertTo-Json -Compress
        $r = Invoke-RestMethod -Uri 'http://127.0.0.1:18187/wake' -Method Post `
            -Headers @{ 'X-Anc-Token' = $token } -ContentType 'application/json; charset=utf-8' `
            -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 20
        Log "wake-directed host=$($activeHost.host_id) conv=$convId queued=$count ok=$($r.ok) via=$($r.via)"
    } elseif ($workspace) {
        # 旧部署兜底：host 没有真实会话 id，只能 /new（D46 已登记的偏差，不再作为常态）
        $body = @{ prompt = $prompt; workspace = $workspace } | ConvertTo-Json -Compress
        $r = Invoke-RestMethod -Uri 'http://127.0.0.1:18187/new' -Method Post `
            -Headers @{ 'X-Anc-Token' = $token } -ContentType 'application/json; charset=utf-8' `
            -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 20
        Log "wake-fallback-new host=$($activeHost.host_id) conv=$convId queued=$count ok=$($r.ok) newconv=$($r.conversationId)"
    } else {
        $body = @{ prompt = $prompt } | ConvertTo-Json -Compress
        $r = Invoke-RestMethod -Uri 'http://127.0.0.1:18187/wake' -Method Post `
            -Headers @{ 'X-Anc-Token' = $token } -ContentType 'application/json; charset=utf-8' `
            -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 5
        Log "wake-current host=$($activeHost.host_id) queued=$count ok=$($r.ok) via=$($r.via)"
    }
    (Get-Date).ToString('o') | Set-Content -Path $lastFile -Encoding utf8
} catch {
    # bridge 未启用/窗口不在，静默；由下一次 tick 或人来消息兜底
    Log ('failed: ' + $_.Exception.Message)
    exit 0
}
exit 0
