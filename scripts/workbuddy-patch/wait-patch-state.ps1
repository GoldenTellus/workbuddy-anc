# 等待「本次启动」的补丁注入确认（VERIFY §58.7-2 / §61）。
# 独立成文件是为了能在临时目录里直接验四种分支（陈旧 / miss / 本次成功 / 超时），
# 不需要真的重启 WorkBuddy。
#
# 为什么必须校验 runId 和时间：patch-state.json 只在补丁体包装成功时被覆盖写；
# 注入失败时它根本不变，会一直留着上一次成功的 applied=true。旧启动器只看
# applied + pid，于是 2 小时前的陈旧状态也会被判成「本次注入成功」。
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$StateFile,
    [Parameter(Mandatory = $true)][string]$RunId,
    [Parameter(Mandatory = $true)][string]$StartedAt,
    [int]$TimeoutSec = 150,
    [int]$PollIntervalSec = 2,
    [string]$PatchLog = ''
)

$ErrorActionPreference = 'Continue'
try { $startUtc = ([datetime]$StartedAt).ToUniversalTime() } catch { $startUtc = (Get-Date).ToUniversalTime() }
$deadline = (Get-Date).AddSeconds($TimeoutSec)
$lastReason = 'patch-state.json 一直没出现（preload 没被加载）'
$lastRaw = ''

while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds $PollIntervalSec
    if (-not (Test-Path $StateFile)) { continue }
    try {
        $raw = [IO.File]::ReadAllText($StateFile, [Text.Encoding]::UTF8).TrimStart([char]0xFEFF)
        $s = $raw | ConvertFrom-Json
        $lastRaw = ($raw -replace '\s+', ' ')
        if (-not [bool]$s.applied) {
            $extra = ''
            if ($s.miss) { $extra = '（ANCHOR-MISS：没找到 emitMessage）' }
            if ($s.error) { $extra = $extra + '：' + $s.error }
            $lastReason = 'patch-state applied=false' + $extra
            continue
        }
        if ($s.runId -and ([string]$s.runId -ne $RunId)) {
            $lastReason = 'patch-state 属于上一次启动（runId=' + $s.runId + '，本次=' + $RunId + '）'
            continue
        }
        # 兼容旧 preload（不写 runId）：至少要求状态是本次启动之后写的。
        $stateAtUtc = ([datetime]$s.at).ToUniversalTime()
        if ($stateAtUtc -lt $startUtc.AddSeconds(-15)) {
            $lastReason = 'patch-state 是陈旧记录（at=' + $s.at + '，本次启动=' + $StartedAt + '）'
            continue
        }
        if ($s.pid -and -not (Get-Process -Id ([int]$s.pid) -ErrorAction SilentlyContinue)) {
            $lastReason = 'patch-state 里的 pid=' + $s.pid + ' 已退出'
            continue
        }
        Write-Host ('[anc] 补丁已生效（applied=true, mode=' + $s.mode + ', pid=' + $s.pid + ', runId=' + $RunId + '）')
        exit 0
    } catch {
        $lastReason = 'patch-state.json 无法解析：' + $_.Exception.Message
    }
}

# 超时必须给可判结论，不再写「不要直接判失败，去看日志」那种含糊话。
Write-Host ('[anc] 注入没成功：' + $lastReason)
Write-Host ('[anc] 判据：runId=' + $RunId + ' / 启动时刻=' + $StartedAt + ' / 等待 ' + $TimeoutSec + ' 秒')
if ($lastRaw) { Write-Host ('[anc] 最后读到的状态: ' + $lastRaw) }
if ($PatchLog) {
    Write-Host ('[anc] 诊断日志: ' + $PatchLog + '（看 INJECTED / APPLIED / ANCHOR-MISS；只有 env set 说明 daemon 没继承 NODE_OPTIONS）')
}
exit 1
