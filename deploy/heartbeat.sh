#!/usr/bin/env bash
#
# Libevra — **外部心跳（Dead Man's Switch）**。
#
# ⚠️ **为什么需要它**：服务器上的脚本只能报告"我失败了"。如果**服务器彻底失效**
# （断电、断网、实例被删、systemd 定时器根本没启动），那就没有脚本能报告任何东西 ——
# 而"什么都没发生"和"一切都好"看起来一模一样。
#
# 所以成功信号发到一个**服务器之外**的服务（Healthchecks.io）。它预期每天在
# 03:00 备份 + 宽限期内收到一次；收不到就**由它**给你发邮件。
#
# ⚠️ **只有整条流程成功才发成功心跳**：本地导出、隔离恢复演练、加密、上传、
# 远端元数据校验全部通过，才调用 `--ok`。任何一项失败都调用 `--fail`，
# 让外部服务**立刻**报警，而不用等到宽限期结束。
#
# 用法：
#   ./heartbeat.sh --ok        # 整条流程成功
#   ./heartbeat.sh --fail "上传失败"   # 任何阶段失败（外部会立即发邮件）
#   ./heartbeat.sh --check     # 只检查配置，不发
#
# ⚠️ 配置在 deploy/.backup-heartbeat.env（600、不进仓库）：
#   HEARTBEAT_URL=https://hc-ping.com/<uuid>
#
# ⚠️ **心跳只是一次 HTTPS GET，不带任何数据** —— 不接触数据库内容、不上传备份文件。

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

BACKUP_DIR="$SCRIPT_DIR/backups"
STATE_FILE="$BACKUP_DIR/heartbeat-state.json"
mkdir -p "$BACKUP_DIR"

MODE=""
REASON=""

while [ $# -gt 0 ]; do
  case "$1" in
    --ok) MODE="ok" ;;
    --fail) MODE="fail"; REASON="${2:-备份流程失败}"; shift ;;
    --check) MODE="check" ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
  shift
done

if [ -f .backup-heartbeat.env ]; then
  # shellcheck disable=SC1091
  set -a; . ./.backup-heartbeat.env; set +a
fi

if [ -z "${HEARTBEAT_URL:-}" ]; then
  echo "⚠️ 外部心跳未配置（deploy/.backup-heartbeat.env 缺 HEARTBEAT_URL）"
  echo "   这意味着**服务器彻底失效时没有人会通知你**。配置见 docs/开发过程记录/S12-C-B-实施与配置指南.md"
  exit 3
fi

if [ "$MODE" = "check" ]; then
  echo "✅ 心跳已配置：$(printf '%s' "$HEARTBEAT_URL" | sed 's#/[^/]*$#/<已隐藏>#')"
  exit 0
fi

case "$MODE" in
  ok)   URL="$HEARTBEAT_URL" ;;
  fail) URL="${HEARTBEAT_URL%/}/fail" ;;
  *) echo "❌ 必须指定 --ok / --fail / --check" >&2; exit 2 ;;
esac

# ⚠️ 心跳失败**不应该**让备份本身算失败（备份成功了就是成功了），
# 但必须被记录下来 —— 否则"监控悄悄失效"没人知道。
HTTP_CODE="$(curl -sS --max-time 15 -o /dev/null -w '%{http_code}' "$URL" 2>/dev/null || echo "000")"

# ⚠️ 状态写作用纯 bash —— 备份告警链路上每多一个依赖，就多一种"关键时刻缺它"的可能。
NOW="$(date +%s)"
OK=false
case "$HTTP_CODE" in 2??) OK=true ;; esac
{
  printf '{\n'
  printf '  "lastMode": "%s",\n' "$MODE"
  printf '  "lastHttpStatus": "%s",\n' "$HTTP_CODE"
  printf '  "lastAttemptAt": %s,\n' "$NOW"
  printf '  "ok": %s,\n' "$OK"
  [ "$OK" = true ] && printf '  "lastSuccessAt": %s,\n' "$NOW"
  [ -n "$REASON" ] && printf '  "lastReason": "%s",\n' "$(printf '%s' "$REASON" | tr -d '"')"
  printf '  "updatedAt": %s\n' "$NOW"
  printf '}\n'
} > "$STATE_FILE.tmp"
mv "$STATE_FILE.tmp" "$STATE_FILE"

if [ "$HTTP_CODE" -ge 200 ] && [ "$HTTP_CODE" -lt 300 ]; then
  echo "✅ 心跳已发送（$MODE，HTTP $HTTP_CODE）"
  exit 0
fi

echo "⚠️ 心跳发送失败（$MODE，HTTP $HTTP_CODE）—— 监控服务没有收到信号" >&2
exit 1
