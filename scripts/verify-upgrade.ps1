# 升级回归的机械检查（W-4）：把「原版→重放→改动后」里能自动判的部分做成可执行检查单。
# 只读：不装补丁、不改文件、不重启 WorkBuddy。
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\verify-upgrade.ps1
#   powershell ... -Json          # 机器可读
# 退出码：0 全通过 / 1 有 FAIL / 2 环境问题
#
# 它判不了的四件事（脚本会打印成清单，需人工在群里做）：
#   1) 群身份前缀 [anc:chat=… from=…] 是否出现；
#   2) @ 提及是否真的高亮到人；
#   3) 多步工具链的出站旁白是否被过滤干净；
#   4) 更新拦截是否生效（客户端不提示升级）。

[CmdletBinding()]
param(
    [string]$Repo = '',
    [string]$PatchDir = "$env:ProgramData\anc\patch",
    [string]$StateFile = "$env:ProgramData\anc\data\patch-state.json",
    [string]$LogFile = "$env:USERPROFILE\anc\workbuddy-patch.log",
    [switch]$Json
)

$ErrorActionPreference = 'Continue'
$results = @()

function Add-R([string]$name, [string]$state, [string]$detail) {
    $script:results += [pscustomobject]@{ check = $name; state = $state; detail = $detail }
}

function Map-InstallDir {
    if ($env:ANC_WORKBUDDY_DIR) { return $env:ANC_WORKBUDDY_DIR }
    $marker = "$env:ProgramData\anc\data\workbuddy-path.txt"
    if (Test-Path $marker) {
        $exe = (Get-Content $marker -Raw).Trim()
        if ($exe -and (Test-Path $exe)) { return (Split-Path -Parent $exe) }
    }
    $guess = Join-Path $env:LOCALAPPDATA 'Programs\WorkBuddy'
    if (Test-Path $guess) { return $guess }
    return ''
}

$installDir = Map-InstallDir
if (-not $installDir) {
    if ($Json) { '{"ok":false,"error":"找不到 WorkBuddy 安装目录"}' } else { Write-Host 'ERROR 找不到 WorkBuddy 安装目录' }
    exit 2
}
if (-not (Test-Path (Join-Path $patchDir 'inspect.mjs'))) {
    if ($Json) { '{"ok":false,"error":"patch 目录不完整: ' + $patchDir + '"}' } else { Write-Host "ERROR patch 目录不完整: $patchDir" }
    exit 2
}

# 1) asar 结构与锚点
$inspect = $null
try {
    $raw = & node (Join-Path $patchDir 'inspect.mjs') $installDir 2>$null | Out-String
    $inspect = $raw | ConvertFrom-Json
} catch { }

if (-not $inspect -or -not $inspect.ok) {
    $errText = $raw; if ($inspect -and $inspect.error) { $errText = $inspect.error }
    Add-R 'asar' 'FAIL' ('inspect 失败: ' + $errText)
} else {
    Add-R 'version' 'PASS' ('WorkBuddy ' + $inspect.version + ' / manifest ' + $inspect.manifest.version)
    if ($inspect.version -ne $inspect.manifest.version) { Add-R 'version-match' 'FAIL' '安装版本与 manifest 不一致，需要重放补丁' }
    else { Add-R 'version-match' 'PASS' '一致' }

    if ($inspect.hashMatches) { Add-R 'target-hash' 'PASS' '目标文件 hash 与 manifest 一致' }
    else { Add-R 'target-hash' 'WARN' ('hash 变了（' + $inspect.sha256.Substring(0, 12) + '…），锚点模式会按结构打，打不上会告警') }

    if ($inspect.anchorsOk) { Add-R 'anchors' 'PASS' ('emitMessage=' + $inspect.anchors.emitMessage + ' class=' + $inspect.anchors.class) }
    else { Add-R 'anchors' 'FAIL' '找不到 emitMessage / WecomAiBotClient，补丁打不上' }

    if ($inspect.bootstrapOk) { Add-R 'bootstrap' 'PASS' ('bootstrap 锚点 ' + $inspect.anchors.bootstrapTotal + ' 处') }
    else { Add-R 'bootstrap' 'FAIL' 'bootstrap 锚点缺失' }
}

# 2) 运行时状态：补丁是否真的应用
if (Test-Path $stateFile) {
    try {
        $st = (Get-Content $stateFile -Raw | ConvertFrom-Json)
        if ($st.applied -eq $true) { Add-R 'applied' 'PASS' ('mode=' + $st.mode + ' at=' + $st.at) }
        elseif ($st.mode) { Add-R 'applied' 'FAIL' ('patch-state 存在但 applied≠true（mode=' + $st.mode + '）') }
        else { Add-R 'applied' 'FAIL' 'patch-state 形状不对' }
    } catch { Add-R 'applied' 'FAIL' 'patch-state 解析失败' }
} else {
    Add-R 'applied' 'FAIL' '没有 patch-state：WorkBuddy 可能不是用 launcher 起的'
}

# 3) 更新拦截钩子
if (Test-Path $logFile) {
    $recent = Get-Content $logFile -Tail 200 | Select-String -Pattern 'update-hook installed'
    if ($recent) { Add-R 'update-hook' 'PASS' '日志里有 update-hook installed' }
    else { Add-R 'update-hook' 'WARN' '最近 200 行日志里没有 update-hook（可能刚重启还没走到）' }
} else {
    Add-R 'update-hook' 'WARN' '没有补丁日志'
}

# 4) doctor 的 patch 检查
$doctor = Join-Path (Split-Path -Parent $PatchDir) 'bin\doctor.ps1'
if (Test-Path $doctor) {
    $args = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $doctor)
    if ($Repo) { $args += @('-Repo', $Repo) }
    $out = & powershell @args 2>&1 | Out-String
    $line = ($out -split "`r?`n" | Where-Object { $_ -match '^\s*(PASS|FAIL|WARN)\s+patch\b' } | Select-Object -First 1)
    if ($line -match '^\s*PASS') { Add-R 'doctor-patch' 'PASS' $line.Trim() }
    elseif ($line) { Add-R 'doctor-patch' 'FAIL' $line.Trim() }
    else { Add-R 'doctor-patch' 'WARN' 'doctor 输出里没找到 patch 检查' }
} else {
    Add-R 'doctor-patch' 'WARN' '找不到 doctor.ps1'
}

$fails = @($results | Where-Object { $_.state -eq 'FAIL' })

$manual = @(
    '在群里 @ 公司 bot 发一句 → 看前缀 [anc:chat=… from=…] 是否出现（canary 会刷新）',
    '让它 @ 某人 → 看手机端是否真的高亮/有「有人@我」',
    '跑一次多步入库（发文件说「入库」）→ 看是否还有「我先查一下」这类过程话漏出来',
    '看客户端是否提示升级 → 不应提示（update 请求被拦成 error）'
)

if ($Json) {
    [pscustomobject]@{
        ok      = ($fails.Count -eq 0)
        install = $installDir
        results = $results
        manual  = $manual
    } | ConvertTo-Json -Depth 5
} else {
    Write-Host ('安装目录: ' + $installDir)
    Write-Host ''
    foreach ($r in $results) { '{0,-6} {1,-16} {2}' -f $r.state, $r.check, $r.detail }
    Write-Host ''
    Write-Host '还需要人工做的四项（脚本判不了）:'
    $i = 1
    foreach ($m in $manual) { '  ' + $i + ') ' + $m; $i++ }
    Write-Host ''
    if ($fails.Count -eq 0) { Write-Host '机械检查：全部通过' } else { Write-Host ('机械检查：' + $fails.Count + ' 项 FAIL') }
}

if ($fails.Count -gt 0) { exit 1 }
exit 0
