# 部署后自动：把仓库路径加入 WorkBuddy 工作区（建会话即自动注册）、发 TEST 冒烟、注册当天 host。
# 两种用法：
#   1) install-company 在 patch 前调用 -Apply -PrepareOnly：只写 wb-wake.flag / wb-wake-workspace.txt，
#      再写 data\deploy-executor-pending.json 交给 patch-guard 在补丁生效后完成（不会因重启丢会话）。
#   2) patch-guard 在补丁 applied 后调用 -Apply -Marker：等价于全自动完成 + 删 marker。
#   也可人工在 WorkBuddy 已打补丁后直接跑：setup-executor.ps1 -Apply
# 退出码：0 成功 / 1 校验失败 / 2 用法或环境 / 3 桥没起来（可重试） / 4 重试超限
[CmdletBinding()]
param(
    [string]$Root = '',
    [string]$Repo = '',
    [string]$Workspace = '',
    [int]$WaitBridgeSeconds = 120,
    [int]$WaitTestSeconds = 90,
    [switch]$SkipTest,
    [switch]$SkipHost,
    [switch]$PrepareOnly,
    [switch]$Marker,
    [switch]$Apply,
    [switch]$Json
)

$ErrorActionPreference = 'Stop'
if (-not $Root) { $Root = Join-Path $env:ProgramData 'anc' }
if (-not $Repo) {
    $c = $PSScriptRoot
    while ($c -and -not (Test-Path (Join-Path $c '.git'))) {
        $p = Split-Path -Parent $c
        if ($p -eq $c) { break }
        $c = $p
    }
    $Repo = $c
}
$dataDir = Join-Path $Root 'data'
$markerFile = Join-Path $dataDir 'deploy-executor-pending.json'
$stateFile = Join-Path $dataDir 'executor-deploy.json'
$failedFile = Join-Path $dataDir 'deploy-executor-failed.json'
$logFile = Join-Path $dataDir 'executor-deploy.log'
$node = 'C:\Program Files\nodejs\node.exe'

function Log([string]$m) {
    try { Add-Content -Path $logFile -Value ((Get-Date).ToString('o') + ' ' + $m) -Encoding utf8 } catch { }
}

function Read-Marker {
    if (-not (Test-Path $markerFile)) { return $null }
    try {
        return ([IO.File]::ReadAllText($markerFile, [Text.Encoding]::UTF8).TrimStart([char]0xFEFF) | ConvertFrom-Json)
    } catch { return $null }
}

function Save-Marker([int]$attempts, [string]$lastError) {
    $mk = [ordered]@{
        at = (Get-Date).ToString('o')
        repo = $Repo
        workspace = $Workspace
        smoke = (-not $SkipTest)
        createHost = (-not $SkipHost)
        attempts = $attempts
        lastError = $lastError
    }
    $json = $mk | ConvertTo-Json -Depth 4
    [IO.File]::WriteAllText($markerFile, $json, (New-Object Text.UTF8Encoding($false)))
}

function Finish([int]$code, $payload) {
    $payload | Add-Member -NotePropertyName at -NotePropertyValue (Get-Date).ToString('o') -Force
    $payload | Add-Member -NotePropertyName ok -NotePropertyValue ($code -eq 0) -Force
    try {
        if ($Apply) { [IO.File]::WriteAllText($stateFile, ($payload | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($false))) }
    } catch { }
    Log ('exit=' + $code + ' ' + (($payload | ConvertTo-Json -Depth 6 -Compress)))
    if ($Json) {
        try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
        $payload | ConvertTo-Json -Depth 6
    } else {
        Write-Output ('exit=' + $code)
        foreach ($k in $payload.Keys) { Write-Output ($k + ' = ' + $payload[$k]) }
    }
    exit $code
}

function Fail-Retry([string]$msg, [int]$code = 1, [int]$attempts = 1) {
    if ($Marker) {
        if ($attempts -ge 20) {
            $fail = [ordered]@{ at = (Get-Date).ToString('o'); error = $msg; attempts = $attempts; workspace = $Workspace }
            [IO.File]::WriteAllText($failedFile, ($fail | ConvertTo-Json -Depth 4), (New-Object Text.UTF8Encoding($false)))
            Remove-Item $markerFile -Force -ErrorAction SilentlyContinue
            Log ('give-up: ' + $msg)
            Finish 4 ([ordered]@{ error = $msg; retry_give_up = $true; attempts = $attempts; failed_file = $failedFile })
        }
        Save-Marker $attempts $msg
    }
    Finish $code ([ordered]@{ error = $msg; attempts = $attempts; marker = $Marker })
}

# ── marker 模式：参数从 marker 取；attempts 累加 ────────────────────────────
$attempts = 1
if ($Marker) {
    $mk = Read-Marker
    if (-not $mk) { Log 'marker missing; nothing to do'; exit 0 }
    $attempts = [int]$mk.attempts + 1
    if ($mk.workspace) { $Workspace = [string]$mk.workspace }
    if ($null -ne $mk.smoke) { $SkipTest = -not [bool]$mk.smoke }
    if ($null -ne $mk.createHost) { $SkipHost = -not [bool]$mk.createHost }
    if ($mk.repo) { $Repo = [string]$mk.repo }
}
if (-not $Workspace) { $Workspace = Join-Path (Split-Path -Parent $Repo) 'anc-executor-ws' }
if (-not $Workspace) { Fail-Retry '缺 Workspace 且无法从仓库推导' 2 $attempts }
if ($Workspace -notmatch '^[A-Za-z]:[\\/]') { Fail-Retry ('workspace 必须是绝对路径: ' + $Workspace) 2 $attempts }

if (-not (Test-Path $Workspace)) {
    try { New-Item -ItemType Directory -Force -Path $Workspace | Out-Null } catch { Fail-Retry ('建工作区目录失败: ' + $_) 2 $attempts }
}
if (-not (Test-Path $dataDir)) { New-Item -ItemType Directory -Force -Path $dataDir | Out-Null }

$wsFile = Join-Path $dataDir 'wb-wake-workspace.txt'
$flagFile = Join-Path $dataDir 'wb-wake.flag'
$tokenFile = Join-Path $dataDir 'wb-wake-token'
$plan = [ordered]@{
    workspace = $Workspace
    repo = $Repo
    root = $Root
    smoke = (-not $SkipTest)
    create_host = (-not $SkipHost)
    prepare_only = [bool]$PrepareOnly
    marker = [bool]$Marker
}

if (-not $Apply) {
    $plan['action'] = 'dry-run（加 -Apply 落盘）'
    Finish 0 $plan
}

# 1) 写 host 工作区配置 + 启用 wake bridge
[IO.File]::WriteAllText($wsFile, $Workspace + "`r`n", (New-Object Text.UTF8Encoding($false)))
if (-not (Test-Path $flagFile)) { New-Item -ItemType File -Force -Path $flagFile | Out-Null }
Log ('config workspace=' + $Workspace)

if ($PrepareOnly) {
    Save-Marker 0 ''
    $plan['action'] = 'prepared（patch 重启后由 patch-guard 完成 TEST + host）'
    $plan['marker'] = $markerFile
    Finish 0 $plan
}

# 2) 等 wake bridge（WorkBuddy 已用补丁启动）
if (-not (Test-Path $tokenFile)) { Fail-Retry '缺 wb-wake-token：WorkBuddy 还没用补丁启动' 3 $attempts }
$token = ([IO.File]::ReadAllText($tokenFile, [Text.Encoding]::UTF8)).Trim()
$health = $null
$deadline = (Get-Date).AddSeconds($WaitBridgeSeconds)
while ((Get-Date) -lt $deadline) {
    try { $health = Invoke-RestMethod -Uri 'http://127.0.0.1:18187/health' -TimeoutSec 2 -ErrorAction Stop } catch { $health = $null }
    if ($health -and $health.bridge -eq '2.0') { break }
    Start-Sleep -Seconds 3
}
if (-not ($health -and $health.bridge -eq '2.0')) {
    Fail-Retry ('wake bridge 未就绪（' + $WaitBridgeSeconds + 's）：先确保 WorkBuddy 用补丁启动器拉起') 3 $attempts
}
$plan['bridge'] = '2.0'

# 3) TEST 冒烟：新建会话（自动把该路径加入 WorkBuddy 工作区）+ 等 bot 回复 TEST
$conv = ''
if (-not $SkipTest) {
    $body = @{ prompt = 'TEST'; workspace = $Workspace; title = 'anc-deploy-check' } | ConvertTo-Json -Compress
    try {
        $r = Invoke-RestMethod -Uri 'http://127.0.0.1:18187/new' -Method Post `
            -Headers @{ 'X-Anc-Token' = $token } -ContentType 'application/json; charset=utf-8' `
            -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 30 -ErrorAction Stop
    } catch { Fail-Retry ('bridge /new 失败: ' + $_.Exception.Message) 1 $attempts }
    if (-not $r.ok -or -not $r.conversationId) { Fail-Retry ('bridge /new 返回异常: ' + ($r | ConvertTo-Json -Compress)) 1 $attempts }
    $conv = [string]$r.conversationId
    $plan['conversation_id'] = $conv
    Log ('test conversation=' + $conv)

    $reply = $null
    $deadline = (Get-Date).AddSeconds($WaitTestSeconds)
    while ((Get-Date) -lt $deadline) {
        $f = Get-ChildItem (Join-Path $env:USERPROFILE '.workbuddy\projects') -Recurse -File -Filter ($conv + '.jsonl') -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($f) {
            try {
                foreach ($line in [IO.File]::ReadAllLines($f.FullName, [Text.Encoding]::UTF8)) {
                    try { $j = $line | ConvertFrom-Json } catch { continue }
                    if ($j.type -eq 'message' -and $j.role -eq 'assistant') {
                        $txt = (@($j.content | ForEach-Object { if ($_.text) { [string]$_.text } }) -join ' ').Trim()
                        if ($txt) { $reply = $txt; break }
                    }
                }
            } catch { }
        }
        if ($reply) { break }
        Start-Sleep -Seconds 3
    }
    if (-not $reply) { Fail-Retry ('已建会话但没等到 bot 回复 TEST（' + $conv + '）') 1 $attempts }
    $plan['test_reply'] = if ($reply.Length -gt 200) { $reply.Substring(0, 200) } else { $reply }
    Log ('test reply=' + $plan['test_reply'])
}

# 4) 当天 host：没有 active 就用这个会话注册；已有 active 则保留（幂等/重部署）
$hostAction = 'skipped'
$hostId = ''
try {
    $cli = Join-Path $Root 'service\cli.ts'
    $db = Join-Path $Root 'data\anc.db'
    if ((Test-Path $cli) -and (Test-Path $node)) {
        $out = & $node --no-warnings $cli --db $db --json executor host status 2>$null | Out-String
        $st = $null
        try { $st = $out | ConvertFrom-Json } catch { }
        $active = @()
        if ($st -and $st.hosts) { $active = @($st.hosts | Where-Object { $_.status -eq 'active' }) }
        if ($active.Count -gt 0) {
            $hostId = [string]$active[0].host_id
            $hostAction = 'existing'
        } elseif (-not $SkipHost) {
            if (-not $conv) { Fail-Retry '没有会话 id，无法注册当天 host（-SkipTest 时不能建 host）' 1 $attempts }
            $today = (Get-Date).ToString('yyyy-MM-dd')
            $cutAt = (Get-Date).Date.AddDays(1).AddHours(3).ToString('o')
            $reg = & $node --no-warnings $cli --db $db --json executor host register --conversation-id $conv --date $today --cut-at $cutAt 2>&1 | Out-String
            $rj = $null
            try { $rj = $reg | ConvertFrom-Json } catch { }
            if (-not ($rj -and $rj.ok -and $rj.host)) { Fail-Retry ('host register 失败: ' + (($reg -split "`n" | Select-Object -Last 2) -join ' ')) 1 $attempts }
            $hostId = [string]$rj.host.host_id
            $hostAction = 'created'
        }
    } else {
        $hostAction = 'cli-missing'
    }
} catch { Fail-Retry ('host 检查/注册失败: ' + $_.Exception.Message) 1 $attempts }
$plan['host_action'] = $hostAction
$plan['host_id'] = $hostId

if ($Marker) { Remove-Item $markerFile -Force -ErrorAction SilentlyContinue }
if ($Apply) {
    # 成功即把 deploy-state 的 executor 阶段记为 done（install-company 不提前记）
    $ds = Join-Path $Root 'tools\deploy-state.ps1'
    if (-not (Test-Path $ds)) { $ds = Join-Path $Root 'bin\deploy-state.ps1' }
    if (Test-Path $ds) {
        try { & powershell -NoProfile -ExecutionPolicy Bypass -File $ds -Side company -Root $Root -Mark executor -AsDone | Out-Null } catch { }
    }
}
$plan['action'] = 'done'
Finish 0 $plan
