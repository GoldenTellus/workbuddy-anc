# 向 SYSTEM 提权执行器投递一条请求（bot 侧用这个）。
#
# 它只做三件事：写一个请求文件、可选地等结果、把结果翻译成人能看的话。
# 真正执行的是 `anc-elevate` 计划任务里的 elevate-runner.ps1（SYSTEM 权限，每分钟一趟）。
#
# 为什么不用「直接提权调用」：
#   bot 是普通权限，弹 UAC 没人点。走队列的好处是：执行者固定是 SYSTEM、
#   动作限定白名单、每条都有审计、失败也能查到是哪次。
#
# 用法：
#   request-elevate.ps1 -Action upgrade -Restart -Wait
#   request-elevate.ps1 -Action register-tasks -Wait
#   request-elevate.ps1 -Action upgrade -Json -Wait -TimeoutSec 600
#
# 退出码：0 成功 / 1 执行失败 / 3 已排队但未在超时内完成 / 2 用法错误

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('upgrade', 'register-tasks', 'deploy')]
    [string]$Action,

    [switch]$Restart,
    [string]$Note = '',
    [string]$Root = '',
    # 等结果的最长秒数；0 = 不等，投递完就返回（自己稍后查 -Check）
    [int]$TimeoutSec = 300,
    # 查一条已有请求的结果（传请求 id）
    [string]$Check = '',
    [switch]$Json
)

$ErrorActionPreference = 'Stop'
if (-not $Root) { $Root = Join-Path $env:ProgramData 'anc' }

$elevDir = Join-Path $Root 'data\elevate'
$queueDir = Join-Path $elevDir 'queue'
$doneDir = Join-Path $elevDir 'done'

function Emit($obj, [int]$code) {
    if ($Json) {
        try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
        $obj | ConvertTo-Json -Depth 5
    } else {
        if ($obj.id) { Write-Output ('请求 id: ' + $obj.id) }
        if ($obj.state) { Write-Output ('状态: ' + $obj.state) }
        if ($obj.tail) { Write-Output '输出末几行:'; Write-Output $obj.tail }
        if ($obj.next) { Write-Output ''; Write-Output ('NEXT  ' + $obj.next) }
    }
    exit $code
}

# ── 查已有请求 ─────────────────────────────────────────────────────────────
if ($Check) {
    $p = Join-Path $doneDir ($Check + '.json')
    if (-not (Test-Path $p)) {
        Emit ([pscustomobject]@{ id = $Check; state = 'pending'; next = '还没执行完（或 id 不对）。anc-elevate 每分钟跑一次，稍后再查。' }) 3
    }
    $r = [IO.File]::ReadAllText($p, [Text.Encoding]::UTF8).TrimStart([char]0xFEFF) | ConvertFrom-Json
    Emit ([pscustomobject]@{ id = $r.id; action = $r.action; state = $(if ($r.ok) { 'ok' } else { 'fail' }); exitCode = $r.exitCode; durationSec = $r.durationSec; tail = $r.tail; next = $(if ($r.ok) { '已完成。' } else { '失败了，看 tail 和 data\elevate\elevate.log。' }) }) $(if ($r.ok) { 0 } else { 1 })
}

# ── 投递 ───────────────────────────────────────────────────────────────────
if (-not (Test-Path $queueDir)) {
    # 通道没启用（老版本部署 / 没跑过 set-acl）
    Emit ([pscustomobject]@{ state = 'unavailable'; next = '提权通道没启用：queue 目录不存在。管理员跑一次 deploy.ps1 -Apply（会带上 anc-elevate 任务）和 set-acl.ps1 -Apply（会建 queue 并授权）。' }) 2
}

$id = [guid]::NewGuid().ToString()
$req = [pscustomobject]@{
    id          = $id
    action      = $Action
    restart     = [bool]$Restart
    requestedBy = $env:USERNAME
    requestedAt = (Get-Date).ToString('o')
    ttlMin      = 30
    note        = $Note
}
$tmp = Join-Path $queueDir ($id + '.tmp')
$dst = Join-Path $queueDir ($id + '.json')
try {
    # 先写 .tmp 再改名：执行器只认 *.json，不会读到写了一半的文件
    [IO.File]::WriteAllText($tmp, ($req | ConvertTo-Json -Depth 4), (New-Object Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $tmp -Destination $dst -Force
} catch {
    Emit ([pscustomobject]@{ state = 'error'; next = ('写请求失败: ' + $_.Exception.Message + '。多半是 queue 目录没有写权限——管理员跑 set-acl.ps1 -Apply。') }) 2
}

if ($TimeoutSec -le 0) {
    Emit ([pscustomobject]@{ id = $id; state = 'queued'; next = ('已排队。anc-elevate 每分钟跑一次，通常 1–2 分钟内开始。稍后用 request-elevate.ps1 -Check ' + $id + ' 查结果。') }) 0
}

# ── 等结果 ─────────────────────────────────────────────────────────────────
$done = Join-Path $doneDir ($id + '.json')
$deadline = (Get-Date).AddSeconds($TimeoutSec)
while ((Get-Date) -lt $deadline) {
    if (Test-Path $done) {
        Start-Sleep -Milliseconds 200
        $r = $null
        try { $r = [IO.File]::ReadAllText($done, [Text.Encoding]::UTF8).TrimStart([char]0xFEFF) | ConvertFrom-Json } catch { }
        if ($r) {
            Emit ([pscustomobject]@{
                id = $r.id; action = $r.action
                state = $(if ($r.ok) { 'ok' } else { 'fail' })
                exitCode = $r.exitCode; durationSec = $r.durationSec; tail = $r.tail
                next = $(if ($r.ok) { '已完成。' } else { '失败了。看 tail；完整审计在 data\elevate\elevate.log。' })
            }) $(if ($r.ok) { 0 } else { 1 })
        }
    }
    Start-Sleep -Seconds 3
}

Emit ([pscustomobject]@{
    id = $id; state = 'pending'
    next = ('排队超过 ' + $TimeoutSec + ' 秒还没执行完。常见原因：anc-elevate 任务没在跑（Get-ScheduledTask anc-elevate）、或这一小时已达执行上限。稍后用 -Check ' + $id + ' 再看。')
}) 3
