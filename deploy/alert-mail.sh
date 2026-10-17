#!/usr/bin/env bash
#
# Libevra — **备份告警邮件**（Resend HTTPS API）。
#
# ⚠️ **这个脚本不能依赖 Libevra 的 API 或 PostgreSQL**：备份失败时，
# 最可能就是这两样东西坏了。它只用 `curl` + `sed`/`awk`，**不依赖 python**，
# 不连数据库、不调网站。
#
# ⚠️ **它区分三件事，绝不混为一谈：**
#
#   apiOk        HTTP 2xx —— "请求到达了 Resend"
#   accepted     Resend 返回了 message id —— "服务商接受发送"
#   delivered    **无法从 API 得知** —— 只能靠真实收件确认
#
# 所以日志与状态只写"服务商已接受"，不写"已送达"。
#
# 用法：
#   ./alert-mail.sh --test
#   ./alert-mail.sh --stage upload --error "上传 COS 失败" [--last-success "…"]
#   ./alert-mail.sh --recovered
#
# ⚠️ 配置在 deploy/.backup-mail.env（600、不进仓库）：
#   MAIL_API_KEY=re_xxx
#   MAIL_TO=you@example.com
#   MAIL_FROM="Libevra 备份 <backup@libevra.com>"
#
# ⚠️ 去重（状态在 backups/alert-state.json）：
#   首次失败立即发；同一阶段 24 小时内最多 1 封；阶段变化立即发；
#   持续失败超过 3 天再发一封；恢复后发一次恢复通知。
#   **限流不等于静默**：长期故障一定会再提醒。

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

BACKUP_DIR="$SCRIPT_DIR/backups"
STATE_FILE="$BACKUP_DIR/alert-state.json"
mkdir -p "$BACKUP_DIR"

STAGE="unknown"
ERROR_MSG=""
LAST_SUCCESS="未知"
MODE="alert"
RETRY_MAX=3

while [ $# -gt 0 ]; do
  case "$1" in
    --test) MODE="test" ;;
    --recovered) MODE="recovered" ;;
    --stage) STAGE="${2:?--stage needs a value}"; shift ;;
    --error) ERROR_MSG="${2:?--error needs a value}"; shift ;;
    --last-success) LAST_SUCCESS="${2:?--last-success needs a value}"; shift ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
  shift
done

# ---------------------------------------------------------------------------
# JSON 读写（纯 bash/sed —— 少一个依赖，就少一种"备份机上学不到"的可能）
# ---------------------------------------------------------------------------
json_num() {
  local v
  v="$(grep -o "\"$1\"[[:space:]]*:[[:space:]]*[0-9][0-9]*" "$STATE_FILE" 2>/dev/null | head -1 | grep -o '[0-9][0-9]*$')"
  echo "${v:-0}"
}
json_str() {
  local v
  v="$(grep -o "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" "$STATE_FILE" 2>/dev/null | head -1 | sed 's/.*:[[:space:]]*"//; s/"$//')"
  echo "$v"
}
json_bool() {
  local v
  v="$(grep -o "\"$1\"[[:space:]]*:[[:space:]]*\(true\|false\)" "$STATE_FILE" 2>/dev/null | head -1 | grep -o 'true\|false')"
  echo "${v:-false}"
}

write_state() {
  # 参数：lastStage lastAlertAt firstFailureAt reminded lastOkAt lastResultJson
  cat > "$STATE_FILE.tmp" <<JSON
{
  "lastStage": "$1",
  "lastAlertAt": $2,
  "firstFailureAt": $3,
  "longFailureReminded": $4,
  "lastOkAt": $5,
  "lastResult": $6,
  "updatedAt": $(date +%s)
}
JSON
  mv "$STATE_FILE.tmp" "$STATE_FILE"
}

NOW="$(date +%s)"
LAST_STAGE="$(json_str lastStage)"
LAST_ALERT_AT="$(json_num lastAlertAt)"
FIRST_FAILURE_AT="$(json_num firstFailureAt)"
REMINDED="$(json_bool longFailureReminded)"
LAST_OK_AT="$(json_num lastOkAt)"
DAY=86400

# ---------------------------------------------------------------------------
# 去重决策
# ---------------------------------------------------------------------------
SHOULD_SEND=false
REASON=""

case "$MODE" in
  test)
    SHOULD_SEND=true; REASON="测试邮件" ;;
  recovered)
    if [ -n "$LAST_STAGE" ] && [ "$LAST_STAGE" != "ok" ]; then
      SHOULD_SEND=true; REASON="恢复通知"
    else
      REASON="没有处于失败状态，不发恢复通知"
    fi ;;
  *)
    if [ -z "$LAST_STAGE" ] || [ "$LAST_STAGE" = "ok" ]; then
      SHOULD_SEND=true; REASON="首次失败，立即通知"
    elif [ "$STAGE" != "$LAST_STAGE" ]; then
      SHOULD_SEND=true; REASON="失败阶段变化，立即通知"
    elif [ "$FIRST_FAILURE_AT" -gt 0 ] && [ $((NOW - FIRST_FAILURE_AT)) -gt $((3 * DAY)) ] && [ "$REMINDED" != "true" ]; then
      SHOULD_SEND=true; REASON="持续失败超过 3 天，再次提醒"
    elif [ "$LAST_ALERT_AT" -gt 0 ] && [ $((NOW - LAST_ALERT_AT)) -ge "$DAY" ]; then
      SHOULD_SEND=true; REASON="同一故障已过 24 小时，再提醒一次"
    else
      REASON="同一故障 24 小时内已通知过，本次不重复"
    fi ;;
esac

if [ "$SHOULD_SEND" != "true" ]; then
  echo "→ 不发邮件：$REASON"
  # ⚠️ 仍然更新"当前故障阶段"，但**不动 lastAlertAt** —— 否则下次该发的时候会被误判为刚发过。
  if [ "$MODE" = "alert" ]; then
    if [ -z "$LAST_STAGE" ] || [ "$LAST_STAGE" = "ok" ]; then
      FIRST_FAILURE_AT="$NOW"
      REMINDED=false
    fi
    write_state "$STAGE" "$LAST_ALERT_AT" "$FIRST_FAILURE_AT" "$REMINDED" "$LAST_OK_AT" "null"
  elif [ "$MODE" = "recovered" ]; then
    write_state ok "0" "0" false "$NOW" "null"
  fi
  exit 0
fi

# ---------------------------------------------------------------------------
# 配置检查（只有真要发的时候才要求配置存在）
# ---------------------------------------------------------------------------
MAIL_ENABLED=false
if [ -f .backup-mail.env ]; then
  # shellcheck disable=SC1091
  set -a; . ./.backup-mail.env; set +a
  if [ -n "${MAIL_API_KEY:-}" ] && [ -n "${MAIL_TO:-}" ] && [ -n "${MAIL_FROM:-}" ]; then
    MAIL_ENABLED=true
  fi
fi
if [ "$MAIL_ENABLED" = false ]; then
  echo "⚠️ 邮件告警未启用：deploy/.backup-mail.env 缺失或缺 MAIL_API_KEY/MAIL_TO/MAIL_FROM"
  echo "   **本次故障不会送达你的邮箱。** 配置见 S12-C-B 指南 §邮件"
  exit 3
fi

if [ "$LAST_SUCCESS" = "未知" ] && [ -f "$BACKUP_DIR/last-run.json" ]; then
  LAST_SUCCESS="$(grep -o '"finishedAt"[[:space:]]*:[[:space:]]*"[^"]*"' "$BACKUP_DIR/last-run.json" | head -1 | sed 's/.*"\([^"]*\)"$/\1/')"
  [ -z "$LAST_SUCCESS" ] && LAST_SUCCESS="未知"
fi

# ---------------------------------------------------------------------------
# 组装邮件（正文绝不含秘密：无口令、无密钥、无邀请码、无账本数据）
# ---------------------------------------------------------------------------
HKT_NOW="$(TZ=Asia/Hong_Kong date '+%Y-%m-%d %H:%M:%S HKT')"
case "$MODE" in
  test) SUBJECT="【Libevra】备份告警测试"; BODY_STAGE="测试邮件（不涉及真实故障）" ;;
  recovered) SUBJECT="【Libevra】备份已恢复"; BODY_STAGE="已恢复" ;;
  *) SUBJECT="【Libevra】备份失败：$STAGE"; BODY_STAGE="$STAGE" ;;
esac

ERROR_SAFE="$(printf '%s' "$ERROR_MSG" | tr -d '"' | tr '\n' ' ' | cut -c1-300)"

BODY="$(cat <<EOF
Libevra 备份告警
================

时间：$HKT_NOW
阶段：$BODY_STAGE
最近一次成功备份：$LAST_SUCCESS

错误摘要：
${ERROR_SAFE:-（无）}

建议检查：
  1. journalctl -u libevra-backup -n 100 --no-pager
  2. cat /srv/libevra/deploy/backups/last-run.json
  3. df -h / ；docker compose ps
  4. 若为 COS 阶段：检查 deploy/.backup.env 与桶权限
  5. 操作手册：docs/生产环境与运维手册.md §15

本邮件由备份脚本直接发出，不依赖 Libevra 网站与数据库。
只表示服务商已接受发送，不表示你已收到——真实送达以收件箱为准。
EOF
)"

# JSON 字符串转义（sed 处理反斜杠/引号/换行）
json_escape() {
  sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e ':a;N;$!ba;s/\n/\\n/g'
}
PAYLOAD="$(printf '{"from":"%s","to":["%s"],"subject":"%s","text":"%s"}' \
  "$(printf '%s' "$MAIL_FROM" | json_escape)" \
  "$(printf '%s' "$MAIL_TO" | json_escape)" \
  "$(printf '%s' "$SUBJECT" | json_escape)" \
  "$(printf '%s' "$BODY" | json_escape)")"

# ---------------------------------------------------------------------------
# 调用 Resend，有限重试
# ---------------------------------------------------------------------------
ATTEMPT=1; API_OK=false; ACCEPTED=false; MESSAGE_ID=""; LAST_HTTP=""; LAST_ERR=""
RESP_FILE="$(mktemp)"; trap 'rm -f "$RESP_FILE"' EXIT

while [ "$ATTEMPT" -le "$RETRY_MAX" ]; do
  HTTP_CODE="$(printf '%s' "$PAYLOAD" | curl -sS --max-time 25 -o "$RESP_FILE" -w '%{http_code}' \
    -X POST "https://api.resend.com/emails" \
    -H "Authorization: Bearer ${MAIL_API_KEY}" \
    -H "Content-Type: application/json; charset=utf-8" \
    --data-binary @- 2>/dev/null || echo "000")"
  LAST_HTTP="$HTTP_CODE"

  if [ "$HTTP_CODE" -ge 200 ] 2>/dev/null && [ "$HTTP_CODE" -lt 300 ] 2>/dev/null; then
    API_OK=true
    MESSAGE_ID="$(sed -n 's/.*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$RESP_FILE" | head -1)"
    [ -n "$MESSAGE_ID" ] && ACCEPTED=true
    break
  fi

  LAST_ERR="$(head -c 300 "$RESP_FILE" 2>/dev/null | tr -d '"' | tr '\n' ' ')"
  echo "⚠️ 第 $ATTEMPT 次发送失败（HTTP $HTTP_CODE）"
  ATTEMPT=$((ATTEMPT + 1))
  [ "$ATTEMPT" -le "$RETRY_MAX" ] && sleep $((2 * ATTEMPT))
done

# ⚠️ 结果写进状态，三个结果分开记（不合并成"发送成功"）
RESULT_JSON="{\"mode\":\"$MODE\",\"stage\":\"$STAGE\",\"apiOk\":$API_OK,\"accepted\":$ACCEPTED,\"messageId\":\"$MESSAGE_ID\",\"httpStatus\":\"$LAST_HTTP\",\"providerError\":\"$(printf '%s' "$LAST_ERR" | tr -d '"' | tr '\n' ' ')\",\"at\":$NOW}"
if [ "$API_OK" = true ]; then
  if [ "$MODE" = "recovered" ]; then
    write_state ok "$NOW" "0" false "$NOW" "$RESULT_JSON"
  else
    [ -z "$LAST_STAGE" -o "$LAST_STAGE" = "ok" ] && FIRST_FAILURE_AT="$NOW"
    [ -n "$FIRST_FAILURE_AT" ] && [ "$FIRST_FAILURE_AT" = "0" ] && FIRST_FAILURE_AT="$NOW"
    write_state "$STAGE" "$NOW" "$FIRST_FAILURE_AT" true "$LAST_OK_AT" "$RESULT_JSON"
  fi
else
  write_state "${LAST_STAGE:-$STAGE}" "$LAST_ALERT_AT" "${FIRST_FAILURE_AT:-$NOW}" "$REMINDED" "$LAST_OK_AT" "$RESULT_JSON"
fi

echo "→ 邮件：apiOk=$API_OK accepted=$ACCEPTED http=$LAST_HTTP messageId=${MESSAGE_ID:-（无）} reason=$REASON"
[ -n "$LAST_ERR" ] && echo "   服务商返回：$LAST_ERR"

if [ "$API_OK" != true ]; then
  echo "❌ 邮件发送失败（已重试 ${RETRY_MAX} 次）——**这次故障没有送达你的邮箱**" >&2
  exit 1
fi

echo "✅ 服务商已接受（messageId=${MESSAGE_ID:-未知}）。⚠️ 这不等于已送达，以收件箱为准。"
exit 0
