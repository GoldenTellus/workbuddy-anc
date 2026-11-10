# 写企微群机器人 webhook 文件（公司侧 §10.5 / §11）。
#
# 为什么脚本化：
#   每个群一个文件，文件名必须和 org 里 member/company 的 `*_webhook_file` 对上。
#   手写有三个坑：① 存成带换行/带 BOM，读出来 URL 尾部多一个 `\r`，推送报 400；
#   ② 文件名写错（含路径、含中文），入库/绑定找不到；③ 写完忘了重设 ACL，secrets 权限就是松的。
#
# 安全：只接受**文件名**（不含路径），且只写进 `<Root>\secrets\`。
#       webhook 明文不进 git、不进 answers、不打日志。
#
# 用法：
#   wecom-setup.ps1 -List                                   # 看现有哪些文件（只显示域名+key 前 6 位）
#   wecom-setup.ps1 -Set 'wecom-webhook.txt=https://qyapi...' -Apply
#   wecom-setup.ps1 -Set 'a.txt=https://...','b.txt=https://...' -Apply
#   wecom-setup.ps1 -FromFile hooks.json -Apply             # {"a.txt":"https://..."}
#
# 退出码：0 成功 / 1 校验失败 / 2 用法或环境错误

[CmdletBinding()]
param(
    [string]$Root = '',
    [string[]]$Set = @(),
    [string]$FromFile = '',
    [switch]$List,
    [switch]$Apply,
    [switch]$Json
)

$ErrorActionPreference = 'Stop'
if (-not $Root) { $Root = Join-Path $env:ProgramData 'anc' }
$secrets = Join-Path $Root 'secrets'
$written = @(); $skipped = @(); $errors = @()

function Finish([int]$code) {
    $ok = ($errors.Count -eq 0)
    $obj = [ordered]@{
        ok      = $ok
        secrets = $secrets
        written = @($written)
        skipped = @($skipped)
        errors  = @($errors)
        next    = if ($List) { '以上是 secrets 里的 webhook 文件（只显示域名与 key 前 6 位，不打印完整地址）。' }
                  elseif (-not $ok) { '先修 errors；webhook 必须 https + 文件名只能是 xxx.txt' }
                  elseif (-not $Apply) { '预演完成。加 -Apply 落盘（要管理员）。' }
                  else { 'webhook 已写入。确认 org 里引用的文件名与这里一致（company.md / members/*.md 的 *_webhook_file）。' }
    }
    if ($Json) {
        try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
        $obj | ConvertTo-Json -Depth 5
    } else {
        foreach ($e in $errors) { Write-Output ('ERROR  ' + $e) }
        foreach ($w in $written) { Write-Output ('写入  ' + $w) }
        foreach ($s in $skipped) { Write-Output ('跳过  ' + $s) }
        Write-Output ''
        Write-Output ('NEXT  ' + $obj.next)
    }
    exit $code
}

# ── -List：只看有哪些，不打印 key ──────────────────────────────────────────
if ($List) {
    if (-not (Test-Path $secrets)) { $skipped += ('没有 secrets 目录: ' + $secrets); Finish 0 }
    foreach ($f in @(Get-ChildItem $secrets -File -Filter '*.txt' -ErrorAction SilentlyContinue)) {
        if ($f.Name -in @('service-token.txt', 'emit-token.txt')) { continue }  # 这两个不是 webhook
        $v = ''
        try { $v = [IO.File]::ReadAllText($f.FullName, [Text.Encoding]::UTF8).Trim() } catch { }
        $safe = if ($v -match '^https://([^/]+)/.*key=([A-Za-z0-9\-]{6})') { $matches[1] + ' key=' + $matches[2] + '…' } else { '（不是预期的 webhook 形态）' }
        $written += ($f.Name + '  →  ' + $safe)
    }
    Finish 0
}

# ── 收集要写的条目 ─────────────────────────────────────────────────────────
$pairs = @()
foreach ($raw in $Set) {
    # 支持一次写多个：`-Set 'a.txt=url1;b.txt=url2'`。
    # 为什么不用数组（-Set 'a=1','b=2'）：用 -File 调脚本时数组会被展开成多个参数，
    # 只有第一个进 -Set，后面几个被当位置参数丢掉——静默少写文件，很难发现。
    foreach ($item in @($raw -split ';')) {
        $s = $item.Trim()
        if (-not $s) { continue }
        $i = $s.IndexOf('=')
        if ($i -le 0) { $errors += ('-Set 格式应为 文件名=URL，收到: ' + $s); continue }
        $pairs += [pscustomobject]@{ Name = $s.Substring(0, $i).Trim(); Url = $s.Substring($i + 1).Trim() }
    }
}
if ($FromFile) {
    if (-not (Test-Path $FromFile)) { $errors += ('找不到 ' + $FromFile); Finish 1 }
    try {
        $j = [IO.File]::ReadAllText($FromFile, [Text.Encoding]::UTF8).TrimStart([char]0xFEFF) | ConvertFrom-Json
        foreach ($p in $j.PSObject.Properties) { $pairs += [pscustomobject]@{ Name = $p.Name; Url = [string]$p.Value } }
    } catch { $errors += ('解析失败: ' + $FromFile + ' —— ' + $_.Exception.Message) }
}
if ($pairs.Count -eq 0) { $errors += '没有要写的条目（用 -Set 或 -FromFile；要看现有的用 -List）' }

# 逐个校验：文件名只能是 xxx.txt，URL 必须 https
foreach ($p in $pairs) {
    if ($p.Name -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*\.txt$') {
        $errors += ('非法文件名: ' + $p.Name + '（只能是字母数字点横线，且以 .txt 结尾，不能带路径）')
    }
    if ($p.Name -match '\.\.') { $errors += ('文件名不能含 ..: ' + $p.Name) }
    if ($p.Url -notmatch '^https://') { $errors += ($p.Name + ' 的 URL 不是 https 开头') }
    if ($p.Url -match '\s') { $errors += ($p.Name + ' 的 URL 含空白（多半是复制时带了换行）') }
    if ($p.Url -notmatch 'qyapi\.weixin\.qq\.com/cgi-bin/webhook/send\?key=') {
        $skipped += ($p.Name + '：不是企微群机器人标准地址，仍按原样写入（确认不是贴错）')
    }
}
if ($errors.Count -gt 0) { Finish 1 }

$isAdmin = $false
try {
    $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
} catch { }
if ($Apply -and -not $isAdmin) {
    $errors += '要管理员权限写 secrets（那里的 ACL 是收紧的）'
    $errors += '用管理员打开 WorkBuddy 再跑；或让管理员执行本命令'
    Finish 2
}

# ── 写入 ───────────────────────────────────────────────────────────────────
# 必须 UTF-8 无 BOM、无结尾换行：读方按整串当 URL 用，尾部一个 \r 就是 400。
foreach ($p in $pairs) {
    $dst = Join-Path $secrets $p.Name
    if (Test-Path $dst) {
        $old = ''
        try { $old = [IO.File]::ReadAllText($dst, [Text.Encoding]::UTF8).Trim() } catch { }
        if ($old -eq $p.Url) { $skipped += ($p.Name + '：内容一致'); continue }
    }
    if (-not $Apply) { $written += ($p.Name + '（dry）'); continue }
    if (-not (Test-Path $secrets)) { New-Item -ItemType Directory -Path $secrets -Force | Out-Null }
    [IO.File]::WriteAllText($dst, $p.Url, (New-Object Text.UTF8Encoding($false)))
    $written += $p.Name
}

# 新文件不继承 secrets 的 ACE，必须重设一次（否则 doctor 的 secrets-acl 会红）
if ($Apply -and $written.Count -gt 0) {
    $setAcl = Join-Path $PSScriptRoot 'set-acl.ps1'
    if (Test-Path $setAcl) {
        $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
        & powershell -NoProfile -ExecutionPolicy Bypass -File $setAcl -Root $Root -Apply 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { $errors += 'set-acl 失败：secrets 权限可能没收紧' }
        $ErrorActionPreference = $eap
    } else {
        $skipped += '没有同目录的 set-acl.ps1，secrets 的 ACL 需要人工重设'
    }
}

Finish 0
