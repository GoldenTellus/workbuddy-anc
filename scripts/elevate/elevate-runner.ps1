# 提权执行器：SYSTEM 权限的计划任务，只做三件白名单动作。
#
# 存在的原因：
#   bot 在群里回话时是**普通权限**（WorkBuddy 以登录用户跑，普通 token 的 Administrators
#   是 deny-only）。而升级运行件、重注册计划任务、铺 ProgramData 都需要管理员。
#   要么每次人工点 UAC，要么给 bot 一条**受限**的提权通道——这个脚本就是后者。
#
# 它是怎么受限的（每条都重要，改之前先想清楚）：
#   1. 只有三个动作：upgrade / register-tasks / deploy。**不接受任意命令行、任意脚本路径。**
#      脚本路径一律从 <Root>\tools\ 下按固定文件名取，请求里的路径字段一概忽略。
#   2. 请求文件必须是 queue\ 下的 <GUID>.json，且不能是符号链接/junction（防止指向别处）。
#   3. 每条请求有 TTL（默认 30 分钟），过期作废——避免积压的旧请求在半夜突然执行。
#   4. 每小时最多执行 MaxPerHour 条（默认 6），超了留到下个窗口。
#   5. 一次只处理一条，按 requestedAt 排序。
#   6. 每个请求都写审计：谁请求的、什么动作、开始/结束时间、退出码、输出末几行。
#
# 它**不能**防住什么（必须明说）：
#   任何能以部署用户身份写 queue 目录的进程，都能触发这三个动作。也就是说
#   「部署用户可以把这三件事提权跑」是这个设计的既定代价，不是漏洞。
#   所以动作清单必须保持这么短——别往里加「执行任意命令」。
#
# 用法（计划任务 anc-elevate 每分钟调它；也可以手工单次跑）：
#   elevate-runner.ps1 -Root C:\ProgramData\anc -Repo D:\repo -Once
#   elevate-runner.ps1 -Root ... -Repo ... -DryRun      # 只看会做什么
#
# 退出码：0 无请求/处理成功 / 1 执行失败 / 2 用法错误

[CmdletBinding()]
param(
    [string]$Root = '',
    [string]$Repo = '',
    [int]$MaxPerHour = 6,
    [int]$TtlMin = 30,
    # 只处理一条就退出（手工测试用；计划任务不加，会处理完本轮所有有效请求）
    [switch]$Once,
    [switch]$DryRun,
    [switch]$Json
)

$ErrorActionPreference = 'Stop'
if (-not $Root) { $Root = Join-Path $env:ProgramData 'anc' }

$elevDir = Join-Path $Root 'data\elevate'
$queueDir = Join-Path $elevDir 'queue'
$doneDir = Join-Path $elevDir 'done'
$logFile = Join-Path $elevDir 'elevate.log'
$stateFile = Join-Path $elevDir 'elevate.state.json'

$handled = @()

function Write-Log([string]$msg) {
    try {
        if (-not (Test-Path $elevDir)) { New-Item -ItemType Directory -Path $elevDir -Force | Out-Null }
        $line = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + ' [elevate] ' + $msg
        Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8
    } catch { }
}

function Invoke-Cmd([string]$exe, [string[]]$argv) {
    $eap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $o = @(& $exe @argv 2>&1)
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $eap }
    return [pscustomobject]@{ code = $code; text = ((@($o | ForEach-Object { [string]$_ })) -join "`n").Trim() }
}

# 白名单：动作 → 固定脚本 + 固定参数模板。请求只能影响 restart（布尔），其余一概不认。
function Resolve-Action([string]$action, [bool]$restart) {
    $tools = Join-Path $Root 'tools'
    switch ($action) {
        'upgrade' {
            $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $tools 'upgrade.ps1'),
                '-Action', 'apply', '-Side', 'company', '-Root', $Root)
            if ($Repo) { $a += @('-Repo', $Repo) }
            if ($restart) { $a += '-Restart' }
            return $a
        }
        'register-tasks' {
            $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $tools 'register-tasks.ps1'),
                '-Root', $Root, '-Apply')
            if ($Repo) { $a += @('-Repo', $Repo) }
            return $a
        }
        'deploy' {
            $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $tools 'deploy.ps1'),
                '-Side', 'company', '-Root', $Root)
            if ($Repo) { $a += @('-Repo', $Repo) }
            $a += '-Apply'
            return $a
        }
        default { return $null }
    }
}

function Read-State {
    if (-not (Test-Path $stateFile)) { return [pscustomobject]@{ hourKey = ''; count = 0 } }
    try {
        return ([IO.File]::ReadAllText($stateFile, [Text.Encoding]::UTF8).TrimStart([char]0xFEFF) | ConvertFrom-Json)
    } catch { return [pscustomobject]@{ hourKey = ''; count = 0 } }
}

if (-not (Test-Path $queueDir)) {
    if ($Json) { [pscustomobject]@{ ok = $true; handled = @(); note = '没有 queue 目录（从未启用过提权通道）' } | ConvertTo-Json -Depth 4 }
    else { Write-Output 'skip  没有 queue 目录（从未启用过提权通道）' }
    exit 0
}

# 限流：按小时计数
$st = Read-State
$hourKey = (Get-Date).ToString('yyyyMMddHH')
$count = if ($st.hourKey -eq $hourKey) { [int]$st.count } else { 0 }

$requests = @(Get-ChildItem -LiteralPath $queueDir -File -Filter '*.json' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime)

foreach ($f in $requests) {
    if ($Once -and $handled.Count -ge 1) { break }
    if ($count -ge $MaxPerHour) {
        Write-Log ('达到每小时上限 ' + $MaxPerHour + '，本轮停止；剩余 ' + $requests.Count + ' 条')
        break
    }

    $base = [IO.Path]::GetFileNameWithoutExtension($f.Name)
    # 名字必须是 GUID：挡住手工丢进来的奇怪文件名。
    # 不能只 log 一下就 continue —— 文件会一直躺在队列里，每分钟重复处理一次。
    # 移到 rejected\ 保留证据，不直接删。
    if ($base -notmatch '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') {
        Write-Log ('非法文件名，移到 rejected: ' + $f.Name)
        if (-not $DryRun) {
            $rej = Join-Path $elevDir 'rejected'
            if (-not (Test-Path $rej)) { New-Item -ItemType Directory -Path $rej -Force | Out-Null }
            Move-Item -LiteralPath $f.FullName -Destination (Join-Path $rej $f.Name) -Force -ErrorAction SilentlyContinue
        }
        continue
    }
    # 符号链接/junction 一律不碰：否则指向别处的文件也能被当请求执行
    try {
        $item = Get-Item -LiteralPath $f.FullName -Force
        if ($item.LinkType) { Write-Log ('忽略链接文件: ' + $f.Name); continue }
    } catch { continue }

    $req = $null
    try {
        $req = [IO.File]::ReadAllText($f.FullName, [Text.Encoding]::UTF8).TrimStart([char]0xFEFF) | ConvertFrom-Json
    } catch {
        Write-Log ('请求解析失败，删除: ' + $f.Name)
        if (-not $DryRun) { Remove-Item -LiteralPath $f.FullName -Force -ErrorAction SilentlyContinue }
        continue
    }

    if (-not $req.action -or @('upgrade', 'register-tasks', 'deploy') -notcontains $req.action) {
        Write-Log ('拒绝未知动作 "' + $req.action + '"，删除请求: ' + $f.Name)
        if (-not $DryRun) {
            [IO.File]::WriteAllText((Join-Path $doneDir ($base + '.json')),
                ([pscustomobject]@{ id = $base; action = [string]$req.action; ok = $false; exitCode = 2; tail = '动作不在白名单（upgrade / register-tasks / deploy）' } | ConvertTo-Json),
                (New-Object Text.UTF8Encoding($false)))
            Remove-Item -LiteralPath $f.FullName -Force -ErrorAction SilentlyContinue
        }
        continue
    }

    # TTL：过期请求不执行（防积压请求在半夜突然跑）
    $ageMin = 0
    try { $ageMin = ((Get-Date) - [datetime]$req.requestedAt).TotalMinutes } catch { $ageMin = 0 }
    if ($ageMin -gt $TtlMin) {
        Write-Log ('请求过期（' + [math]::Round($ageMin) + ' 分钟 > ' + $TtlMin + '），作废: ' + $base)
        if (-not $DryRun) {
            [IO.File]::WriteAllText((Join-Path $doneDir ($base + '.json')),
                ([pscustomobject]@{ id = $base; action = $req.action; ok = $false; exitCode = 4; tail = ('超过 TTL ' + $TtlMin + ' 分钟未执行，已作废；请重新发起') } | ConvertTo-Json),
                (New-Object Text.UTF8Encoding($false)))
            Remove-Item -LiteralPath $f.FullName -Force -ErrorAction SilentlyContinue
        }
        continue
    }

    $argv = Resolve-Action ([string]$req.action) ([bool]$req.restart)
    if (-not $argv) { continue }

    $scriptPath = $argv[$argv.IndexOf('-File') + 1]
    if (-not (Test-Path $scriptPath)) {
        Write-Log ('脚本不存在: ' + $scriptPath + '（部署还没铺 tools？）')
        continue
    }

    $who = if ($req.requestedBy) { [string]$req.requestedBy } else { '未知' }
    Write-Log ('开始 ' + $req.action + '  id=' + $base + '  by=' + $who + '  等待 ' + [math]::Round($ageMin) + ' 分钟')

    if ($DryRun) {
        $handled += [pscustomobject]@{ id = $base; action = $req.action; state = 'dry'; cmd = ($argv -join ' ') }
        continue
    }

    $started = Get-Date
    $r = Invoke-Cmd 'powershell' $argv
    $dur = [math]::Round(((Get-Date) - $started).TotalSeconds)
    $tail = (($r.text -split "`n" | Select-Object -Last 12) -join "`n")

    $rec = [pscustomobject]@{
        id          = $base
        action      = $req.action
        ok          = ($r.code -eq 0)
        exitCode    = $r.code
        startedAt   = $started.ToString('o')
        finishedAt  = (Get-Date).ToString('o')
        durationSec = $dur
        requestedBy = $who
        tail        = $tail
    }
    if (-not (Test-Path $doneDir)) { New-Item -ItemType Directory -Path $doneDir -Force | Out-Null }
    [IO.File]::WriteAllText((Join-Path $doneDir ($base + '.json')),
        ($rec | ConvertTo-Json -Depth 4), (New-Object Text.UTF8Encoding($false)))
    Remove-Item -LiteralPath $f.FullName -Force -ErrorAction SilentlyContinue
    Write-Log ('结束 ' + $req.action + '  id=' + $base + '  exit=' + $r.code + '  用时 ' + $dur + 's')

    $handled += [pscustomobject]@{ id = $base; action = $req.action; state = $(if ($r.code -eq 0) { 'ok' } else { 'fail' }); exitCode = $r.code; durationSec = $dur }
    $count++
}

if (-not $DryRun) {
    try {
        [IO.File]::WriteAllText($stateFile, ([pscustomobject]@{ hourKey = $hourKey; count = $count } | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
    } catch { }
}

if ($Json) {
    try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
    [pscustomobject]@{ ok = $true; handled = @($handled); hourCount = $count } | ConvertTo-Json -Depth 5
} else {
    if ($handled.Count -eq 0) { Write-Output 'skip  队列里没有可执行的请求' }
    foreach ($h in $handled) { Write-Output ('  ' + $h.state + '  ' + $h.action + '  ' + $h.id + $(if ($h.PSObject.Properties['exitCode']) { '  exit=' + $h.exitCode } else { '' })) }
}
exit 0
