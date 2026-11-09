# 每分钟检查 executor 队列；只有 queued Ticket 时才唤醒当前 WorkBuddy 对话。
# 没有 wb-wake.flag / wake bridge 时静默退出，不碰 UI。
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:ProgramData 'anc'
$db = Join-Path $root 'data\anc.db'
$node = 'C:\Program Files\nodejs\node.exe'
$tokenFile = Join-Path $root 'data\wb-wake-token'
$lastFile = Join-Path $root 'data\executor-wake-last.txt'
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
    $active = @($hosts.hosts | Where-Object { $_.status -eq 'active' }).Count
    if ($active -le 0) { exit 0 }
    $token = (Get-Content $tokenFile -Raw).Trim()
    $prompt = "[anc-executor] 队列有 $count 个 Ticket。请只做一个 tick：executor claim，按 anc-executor 技能派 subagent；没有空槽就停止，不要回复用户。"
    $body = @{ prompt = $prompt } | ConvertTo-Json -Compress
    Invoke-RestMethod -Uri 'http://127.0.0.1:18187/wake' -Method Post `
        -Headers @{ 'X-Anc-Token' = $token } -ContentType 'application/json; charset=utf-8' `
        -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 5 | Out-Null
    (Get-Date).ToString('o') | Set-Content -Path $lastFile -Encoding utf8
} catch {
    # bridge 未启用/窗口不在，静默；由下一次 tick 或人来消息兜底
    exit 0
}
exit 0
