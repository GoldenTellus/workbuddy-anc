# 03:00 自动兜底：如果 WorkBuddy 新对话还没出现，不硬切 host。
# 只标记 cut_deferred；旧 host 继续接单。新对话首个 turn 调 host bootstrap 再切。
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:ProgramData 'anc'
$node = 'C:\Program Files\nodejs\node.exe'
$db = Join-Path $root 'data\anc.db'
$log = Join-Path $root 'data\executor-host-tick.log'
if (-not (Test-Path $node)) { exit 0 }
& $node --no-warnings (Join-Path $root 'service\cli.ts') executor host tick --db $db --json 2>&1 |
    Out-File -FilePath $log -Append -Encoding utf8
exit $LASTEXITCODE
