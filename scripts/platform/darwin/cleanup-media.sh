#!/bin/sh
# cleanup-media：清企微附件落地目录（macOS 薄壳）。
#
# 由 launchd 的 local.anc.anc-cleanup 每天 03:00 调用（plist 里带 --days 7）。
# 真正的判定（哪些目录算附件目录、跳过符号链接、按 mtime 删）在 Node 侧：
#   <root>/bin/cleanup-media.mjs  ← scripts/backup/cleanup-media.mjs（部署时复制）
# shell 这一层**不做任何删除**，也不算天数 —— 一个 bug 就能删到用户文件。
#
# <root> 解析：ANC_ROOT → --root=<dir> → 默认 /Library/Application Support/anc
# 退出码：0 正常 / 2 环境错误（找不到 node 或 mjs）

set -eu

ROOT="${ANC_ROOT:-/Library/Application Support/anc}"
for a in "$@"; do
  case "$a" in
    --root=*) ROOT="${a#--root=}" ;;
  esac
done

MJS="$ROOT/bin/cleanup-media.mjs"

find_node() {
  if command -v node >/dev/null 2>&1; then command -v node; return 0; fi
  for p in /usr/local/bin/node /opt/homebrew/bin/node /usr/bin/node; do
    if [ -x "$p" ]; then printf '%s\n' "$p"; return 0; fi
  done
  return 1
}

if ! NODE="$(find_node)"; then
  printf 'ERROR 找不到 node（清理脚本要它跑 mjs）；装 Node 22+ 或把 node 目录加进 PATH\n' >&2
  exit 2
fi
if [ ! -f "$MJS" ]; then
  printf 'ERROR 找不到 %s；先跑部署引擎铺文件（scripts/deploy/deploy.mjs --apply）\n' "$MJS" >&2
  exit 2
fi

export ANC_SIDE="${ANC_SIDE:-company}"
export ANC_ROOT="$ROOT"
exec "$NODE" "$MJS" --root "$ROOT" "$@"
