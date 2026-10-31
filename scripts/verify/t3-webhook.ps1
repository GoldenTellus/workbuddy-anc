# T3 实测：群机器人能否按成员 ID @ 到人
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\verify\t3-webhook.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\verify\t3-webhook.ps1 -Mobile   # 改用手机号 @
# 输入文件（不进仓库，不打印内容）：
#   %USERPROFILE%\anc-test\webhook.txt   群机器人 webhook 地址
#   %USERPROFILE%\anc-test\userid.txt    被 @ 的成员 userid，每行一个
# 退出码：0 errcode=0 / 1 发送失败 / 2 输入缺失

[CmdletBinding()]
param(
    [string]$WebhookFile = "$env:USERPROFILE\anc-test\webhook.txt",
    [string]$UserIdFile = "$env:USERPROFILE\anc-test\userid.txt",
    [string]$Text = "T3 测试：到点提醒",
    [switch]$Mobile,
    [switch]$NoMention
)

$ErrorActionPreference = 'Stop'

function Fail([string]$msg, [string]$fix, [int]$code) {
    Write-Host "ERROR $msg"
    Write-Host "FIX   $fix"
    exit $code
}

if (-not (Test-Path $WebhookFile)) { Fail "缺少 webhook 文件: $WebhookFile" '在 G1 群设置 → 群机器人 → 添加，把 webhook 存进这个文件（不要贴进对话）' 2 }
if (-not $NoMention -and -not (Test-Path $UserIdFile)) { Fail "缺少 userid 文件: $UserIdFile" '把要 @ 的成员 userid 每行一个写进这个文件' 2 }

$url = (Get-Content $WebhookFile -Raw).Trim()
if ($url -notmatch '^https://qyapi\.weixin\.qq\.com/cgi-bin/webhook/send\?key=') {
    Fail 'webhook 地址形态不对（应以 https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key= 开头）' '确认复制的是群机器人 webhook，不是应用消息接口' 2
}

$ids = @()
if (-not $NoMention) {
    $ids = Get-Content $UserIdFile | ForEach-Object { $_.Trim() } | Where-Object { $_ } | Select-Object -Unique
    if ($ids.Count -eq 0) { Fail 'userid 文件是空的' '写入至少一个 userid' 2 }
}

function Esc([string]$s) { return ($s -replace '\\', '\\\\' -replace '"', '\"') }

$content = Esc $Text
$mention = ''
if (-not $NoMention -and $ids.Count -gt 0) {
    $key = if ($Mobile) { 'mentioned_mobile_list' } else { 'mentioned_list' }
    $list = ($ids | ForEach-Object { '"' + (Esc $_) + '"' }) -join ','
    $mention = ',"' + $key + '":[' + $list + ']'
}
$body = '{"msgtype":"text","text":{"content":"' + $content + '"' + $mention + '}}'

$bytes = [Text.Encoding]::UTF8.GetBytes($body)
try {
    $resp = Invoke-RestMethod -Uri $url -Method Post -ContentType 'application/json; charset=utf-8' -Body $bytes -TimeoutSec 20
} catch {
    Fail ('请求失败: ' + $_.Exception.Message) '检查网络与 webhook 是否有效' 1
}

$errcode = $resp.errcode
$errmsg = $resp.errmsg
$mode = if ($NoMention) { '不 @' } elseif ($Mobile) { '手机号 @' } else { 'userid @' }
Write-Host ("[t3] 模式={0} 目标数={1} errcode={2} errmsg={3}" -f $mode, $ids.Count, $errcode, $errmsg)
if ($errcode -ne 0) {
    Write-Host 'FIX   换 mentioned_mobile_list（-Mobile）再试；仍不行就改成只发群消息（-NoMention）'
    exit 1
}
Write-Host '[t3] 发送成功。请在手机上确认：消息里有没有被 @ 高亮、有没有「有人@我」提醒。'
exit 0
