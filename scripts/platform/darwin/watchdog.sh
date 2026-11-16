#!/bin/sh
# watchdog：心跳 / outbox 积压 / WorkBuddy 进程告警（macOS 薄壳）。
#
# 由 launchd 的 local.anc.anc-watchdog 每 10 分钟调用。
# 判定逻辑全在 Node 侧：<root>/bin/watchdog.mjs ← scripts/selfheal/watchdog.mjs
#   （心跳看 <root>/data/loop.log 的 mtime、积压查 CLI outbox、进程按平台用 pgrep/ps）
# shell 只负责：找到 node、把 <root> 传下去、把参数原样转发。
#
# 告警通道：<root>/secrets/ops-webhook.txt（**文件**，不进 plist、不进环境变量）。
#
# <root> 解析：ANC_ROOT → --root=<dir> → 默认 /Library/Application Support/anc
# 退出码：0 正常或已告警 / 2 环境错误

set -eu

ROOT="${ANC_ROOT:-/Library/Application Support/anc}"
for a in "$@"; do
  case "$a" in
    --root=*) ROOT="${a#--root=}" ;;
  esac
done

MJS="$ROOT/bin/watchdog.mjs"

find_node() {
  if command -v node >/dev/null 2>&1; then command -v node; return 0; fi
  for p in /usr/local/bin/node /opt/homebrew/bin/node /usr/bin/node; do
    if [ -x "$p" ]; then printf '%s\n' "$p"; return 0; fi
  done
  return 1
}

if ! NODE="$(find_node)"; then
  printf 'ERROR 找不到 node（watchdog 要它跑 mjs）\n' >&2
  exit 2
fi
if [ ! -f "$MJS" ]; then
  printf 'ERROR 找不到 %s；先跑部署引擎铺文件（scripts/deploy/deploy.mjs --apply）\n' "$MJS" >&2
  exit 2
fi

export ANC_SIDE="${ANC_SIDE:-company}"
export ANC_ROOT="$ROOT"
exec "$NODE" "$MJS" --root "$ROOT" "$@"
