#!/usr/bin/env bash
#
# Libevra — **测试告警渠道**（不会碰备份，只发一条消息）。
#
# ⚠️ 在它成功之前，系统**不会**声称"已经有失败通知"。
#
# 用法：
#   ./deploy/notify-test.sh            # 发一条测试消息
#   ./deploy/notify-test.sh --check    # 只检查配置，不发

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [ ! -f .backup-notify.env ]; then
  echo "❌ 通知未启用：deploy/.backup-notify.env 不存在。"
  echo "   模板与填写说明在本机 Documents/Libevra-敏感信息（勿上传）/telegram-bot-token.txt"
  exit 1
fi
# shellcheck disable=SC1091
set -a; . ./.backup-notify.env; set +a

if [ -z "${TELEGRAM_BOT_TOKEN:-}" ] || [ -z "${TELEGRAM_CHAT_ID:-}" ]; then
  echo "❌ 通知未启用：TELEGRAM_BOT_TOKEN 或 TELEGRAM_CHAT_ID 为空。"
  exit 1
fi

if [ "${1:-}" = "--check" ]; then
  echo "✅ 配置存在（token 长度 ${#TELEGRAM_BOT_TOKEN}，chat_id ${TELEGRAM_CHAT_ID}）—— 尚未发送测试消息。"
  exit 0
fi

RESPONSE="$(curl -sS --max-time 20 \
  "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe" 2>&1 || true)"
if ! printf '%s' "$RESPONSE" | grep -q '"ok":true'; then
  echo "❌ Bot token 无效（getMe 没返回 ok）。" >&2
  echo "   响应：$(printf '%s' "$RESPONSE" | head -c 200)" >&2
  exit 1
fi
echo "✅ Bot token 有效：$(printf '%s' "$RESPONSE" | sed -n 's/.*"username":"\([^"]*\)".*/\1/p')"

curl -sS --max-time 20 -o /dev/null -w '' \
  "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
  --data-urlencode "text=Libevra 备份告警测试：收到这条消息说明通知渠道可用。（$(date '+%Y-%m-%d %H:%M:%S %Z')）" \
  --data "" >/dev/null 2>&1 || {
  echo "❌ 发送失败：Telegram 返回非 2xx。检查 chat_id 是否正确、是否先给 bot 发过一条消息。" >&2
  exit 1
}

echo "✅ 已发送测试消息 —— 请到 Telegram 确认收到。"
echo "   收到之后，才能说\"失败通知已具备\"。"
