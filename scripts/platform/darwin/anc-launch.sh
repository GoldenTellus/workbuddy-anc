#!/bin/sh
# anc-workbuddy-launch：用补丁启动器拉起 WorkBuddy（macOS 薄壳）。
#
# 为什么这么薄：
#   2026-11-16 真机验收（WorkBuddy 5.9.3 / Electron 37.10.3）结论——启动器自己拼注入参数是错的方向：
#     ① 包内可执行文件不一定叫 WorkBuddy，本机实测是 Contents/MacOS/Electron（CFBundleExecutable=Electron）；
#     ② Electron 打包应用会丢弃 NODE_OPTIONS（--require 预载不生效），唯一可行路径是
#        `--inspect-brk` 暂停 + inject.cjs 在主进程设 env 再放行（与 Windows 侧 .ps1 的实测一致）。
#   所以这里只做三件事：解析 <root>、找 node、把活交给 patch/launch-patched.mjs。
#   判定、重试、patch-state 等待、降级，全在 Node 启动器里，两端共用一份逻辑。
#
# 部署位置：<root>/bin/anc-launch.sh，由 launchd 的 local.anc.anc-workbuddy-launch 调用
#          （见 scripts/deploy/scheduler.mjs 的 plist 渲染）。
#
# <root> 解析顺序：ANC_ROOT → --root=<dir> → 默认 /Library/Application Support/anc
#   company 用默认值；employee 侧由 plist 的 ANC_ROOT 指到 ~/Library/Application Support/anc
#
# 退出码：0 补丁已生效并拉起 / 1 已降级无补丁拉起（WorkBuddy 在线但群身份不可用）/ 2 环境错误

set -eu

ROOT="${ANC_ROOT:-/Library/Application Support/anc}"
for a in "$@"; do
  case "$a" in
    --root=*) ROOT="${a#--root=}" ;;
  esac
done

LAUNCHER="$ROOT/patch/launch-patched.mjs"
APP="${ANC_WORKBUDDY_APP:-/Applications/WorkBuddy.app}"

find_node() {
  if command -v node >/dev/null 2>&1; then command -v node; return 0; fi
  for p in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    if [ -x "$p" ]; then printf '%s\n' "$p"; return 0; fi
  done
  return 1
}

NODE="$(find_node)" || {
  echo "ERROR 找不到 node（Homebrew 默认 /opt/homebrew/bin/node）" >&2
  exit 2
}

export ANC_SIDE="${ANC_SIDE:-company}"
export ANC_ROOT="$ROOT"
export ANC_WB_PATCH=1

# 补丁目录没铺：降级无补丁启动，**退出码 1**（与 Windows launch-patched.ps1 同语义：降级不等于成功）
if [ ! -f "$LAUNCHER" ]; then
  echo "WARN 没有 $LAUNCHER，降级无补丁启动；跑一次 deploy/anc.mjs install 后再重启" >&2
  /usr/bin/open -a "$APP" || exit 1
  exit 1
fi

set -- --state-dir "$ROOT/data" --port "${ANC_WB_PORT:-9229}"
if [ -n "${ANC_WORKBUDDY_APP:-}" ]; then
  set -- "$@" --install-dir "$ANC_WORKBUDDY_APP"
fi
exec "$NODE" "$LAUNCHER" "$@"
