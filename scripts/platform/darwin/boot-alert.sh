#!/bin/sh
# boot-alert：开机后 WorkBuddy 没起来就告警（macOS 薄壳）。
#
# 由 launchd 的 local.anc.anc-boot-alert 调用（RunAtLoad + 每 10 分钟重试）。
# 与 Windows 的 scripts/selfheal/boot-alert.ps1 对齐：等一会儿 → 看进程 → 不在就发运维群。
#
# 为什么用 pgrep 而不是 node：这条告警要在"什么都还没跑起来"的时候工作，
# 依赖越少越可靠。它只做一件事 —— 判断 + 发一条 HTTP。
#
# 告警地址：<root>/secrets/ops-webhook.txt（文件，绝不进 plist / 环境变量）。
#
# <root> 解析：ANC_ROOT → --root=<dir> → 默认 /Library/Application Support/anc
# 退出码：0 正常或已告警 / 1 告警发送失败 / 2 环境错误（没有 webhook 文件）

set -eu

ROOT="${ANC_ROOT:-/Library/Application Support/anc}"
for a in "$@"; do
  case "$a" in
    --root=*) ROOT="${a#--root=}" ;;
  esac
done

WAIT="${ANC_BOOT_ALERT_WAIT:-60}"
WEBHOOK_FILE="$ROOT/secrets/ops-webhook.txt"

# WorkBuddy 在跑就什么都不做（开机自启成功是最常见的情况，别刷告警）
sleep "$WAIT"
if pgrep -f 'WorkBuddy.app/Contents/MacOS/WorkBuddy' >/dev/null 2>&1; then
  exit 0
fi

if [ ! -f "$WEBHOOK_FILE" ]; then
  printf 'no ops webhook (%s), skip\n' "$WEBHOOK_FILE" >&2
  exit 2
fi
URL="$(tr -d '\r\n' <"$WEBHOOK_FILE")"
if [ -z "$URL" ]; then
  printf 'ops webhook empty, skip\n' >&2
  exit 2
fi

BODY='{"msgtype":"text","text":{"content":"[anc] 主机已重启，但 WorkBuddy 还没起来：公司 bot 当前离线，请登录恢复。"}}'

if curl -sS -m 15 -H 'Content-Type: application/json; charset=utf-8' \
     --data-binary "$BODY" "$URL" >/dev/null 2>&1; then
  printf 'alert sent\n'
  exit 0
fi
printf 'alert failed\n' >&2
exit 1
