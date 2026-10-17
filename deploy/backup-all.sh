#!/usr/bin/env bash
#
# Libevra — **一次完整的备份**：
#   本地备份与隔离恢复演练 → 加密 → 上传 COS → 远端元数据校验 → 写状态 → 心跳 → 失败告警
#
# ⚠️ **五个结果分开记，绝不合并成一个"备份成功"。**
#
#   localOk     本地导出成功（文件存在、大小合理、归档可解析）
#   restoreOk   隔离恢复演练通过（逐表行数一致）
#   encryptOk   AES-256 加密成功
#   uploadOk    上传 COS 成功
#   remoteMetaOk 远端确认：对象存在且**大小与本地加密文件一致**（HeadObject，不读内容）
#   heartbeatOk 外部 Dead Man's Switch 收到成功信号
#   notifyOk    失败告警是否被服务商接受
#
# ⚠️ **"异地内容验证"不在这里。** 上传身份**没有读取权限**（这是有意的），
# 所以日常只能校验元数据。**内容级验证（下载→解密→隔离恢复）每月一次**，
# 用恢复身份在你自己的机器上跑：`monthly-offsite-drill.sh`。
#
# 用法：
#   ./backup-all.sh                      # 完整流程（定时任务跑这个）
#   ./backup-all.sh --skip-offsite       # 只做本地（异地未配置时）
#   ./backup-all.sh --skip-heartbeat     # 不发送心跳（本地调试用）
#   ./backup-all.sh --skip-notify        # 不发告警（本地调试用）
#
# ⚠️ 秘密文件（全部 600、全部在 .gitignore 里）：
#   .backup.key        加密口令（**已存在，不得轮换/覆盖**）
#   .backup.env        上传身份：COS_UPLOAD_ID / COS_UPLOAD_KEY / COS_BUCKET / COS_REGION / COS_ENDPOINT
#   .backup-mail.env   邮件告警：MAIL_API_KEY / MAIL_TO / MAIL_FROM
#   .backup-heartbeat.env  外部心跳：HEARTBEAT_URL
#   ⚠️ **恢复身份不在这里**：`COS_RESTORE_*` 只在你自己的机器上，服务器不常驻。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

BACKUP_DIR="$SCRIPT_DIR/backups"
mkdir -p "$BACKUP_DIR"

STATUS_FILE="$BACKUP_DIR/last-run.json"
LOCAL_STATUS="$BACKUP_DIR/last-local.json"
LOCK_FILE="$SCRIPT_DIR/.backup.lock"

SKIP_OFFSITE=0
SKIP_HEARTBEAT=0
SKIP_NOTIFY=0
PASSTHROUGH=()
while [ $# -gt 0 ]; do
  case "$1" in
    --skip-offsite) SKIP_OFFSITE=1 ;;
    --skip-heartbeat) SKIP_HEARTBEAT=1 ;;
    --skip-notify) SKIP_NOTIFY=1 ;;
    --keep) PASSTHROUGH+=(--keep "${2:?--keep needs a number}"); shift ;;
    --no-restore-drill) PASSTHROUGH+=(--no-restore-drill) ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
  shift
done

# ⚠️ 并发保护：systemd 不让同一 unit 并发，但**手动执行**很常见。
exec 9> "$LOCK_FILE"
if ! flock -n 9; then
  echo "❌ 已经有一次备份在运行（$LOCK_FILE 被占用）。本次退出。" >&2
  exit 0
fi

STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
FINAL_ERROR=""

LOCAL_OK=false
RESTORE_OK=false
ENCRYPT_OK=false
UPLOAD_OK=false
REMOTE_META_OK=false
HEARTBEAT_OK=false
HEARTBEAT_CONFIGURED=false
NOTIFY_OK=false
NOTIFY_CONFIGURED=false

OFFSITE_CONFIGURED=false
OFFSITE_ERROR=""
OFFSITE_REF=""
REMOTE_SIZE=""
LOCAL_ENC_SIZE=""

# ---------------------------------------------------------------------------
# 载入秘密（缺失不报错：可能还没配置）
# ---------------------------------------------------------------------------
if [ -f .backup.env ]; then
  # shellcheck disable=SC1091
  set -a; . ./.backup.env; set +a
fi
if [ -f .backup-mail.env ]; then
  # shellcheck disable=SC1091
  set -a; . ./.backup-mail.env; set +a
fi
if [ -f .backup-heartbeat.env ]; then
  # shellcheck disable=SC1091
  set -a; . ./.backup-heartbeat.env; set +a
fi

[ -n "${HEARTBEAT_URL:-}" ] && HEARTBEAT_CONFIGURED=true
if [ -f .backup-mail.env ] && [ -n "${MAIL_API_KEY:-}" ] && [ -n "${MAIL_TO:-}" ] && [ -n "${MAIL_FROM:-}" ]; then
  NOTIFY_CONFIGURED=true
fi

write_final_status() {
  local finished_at local_json="{}"
  local monthlyMonthValue="${MONTHLY_MONTH:-}" monthlyRefValue="${MONTHLY_REF:-}"
  finished_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  [ -f "$LOCAL_STATUS" ] && local_json="$(cat "$LOCAL_STATUS")"

  cat > "$STATUS_FILE.tmp" <<JSON
{
  "kind": "full",
  "schemaVersion": 2,
  "startedAt": "$STARTED_AT",
  "finishedAt": "$finished_at",
  "local": $local_json,
  "encryptOk": $ENCRYPT_OK,
  "offsite": {
    "configured": $OFFSITE_CONFIGURED,
    "uploadOk": $UPLOAD_OK,
    "remoteMetaOk": $REMOTE_META_OK,
    "ref": "$OFFSITE_REF",
    "localEncryptedSize": ${LOCAL_ENC_SIZE:-0},
    "remoteSize": ${REMOTE_SIZE:-0},
    "contentVerified": false,
    "contentVerifiedNote": "内容级验证由 monthly-offsite-drill.sh 用恢复身份执行",
    "monthlyMonth": "${MONTHLY_MONTH:-}",
    "monthlyRef": "${MONTHLY_REF:-}"
  },
  "heartbeat": {
    "configured": $HEARTBEAT_CONFIGURED,
    "ok": $HEARTBEAT_OK
  },
  "notify": {
    "configured": $NOTIFY_CONFIGURED,
    "ok": $NOTIFY_OK
  },
  "error": $(if [ -n "$FINAL_ERROR" ]; then printf '"%s"' "$(printf '%s' "$FINAL_ERROR" | tr -d '"' | tr '\n' ' ')"; else printf 'null'; fi)
}
JSON
  mv "$STATUS_FILE.tmp" "$STATUS_FILE"
}

last_success_at() {
  if [ -f "$STATUS_FILE" ]; then
    grep -o '"finishedAt": *"[^"]*"' "$STATUS_FILE" | head -1 | sed 's/.*"finishedAt": *"//; s/"$//'
  fi
}

# ⚠️ 告警与心跳**都不能影响退出码本身**：备份失败就是失败，通知是尽力而为。
notify_failure() {
  local stage="$1" message="$2"
  if [ "$SKIP_NOTIFY" -eq 1 ]; then return 0; fi
  local prev
  prev="$(last_success_at)"
  if ./alert-mail.sh --stage "$stage" --error "$message" --last-success "${prev:-未知}"; then
    NOTIFY_OK=true
  fi
}

ping_heartbeat() {
  local mode="$1" reason="${2:-}"
  if [ "$SKIP_HEARTBEAT" -eq 1 ]; then return 0; fi
  if [ "$mode" = "ok" ]; then
    if ./heartbeat.sh --ok; then HEARTBEAT_OK=true; fi
  else
    ./heartbeat.sh --fail "$reason" || true
  fi
}

# 任何一步失败：通知 + 失败心跳 + 写状态 + 非零退出
fail_stage() {
  local stage="$1" message="$2"
  FINAL_ERROR="$message"
  echo "❌ [$stage] $message" >&2
  notify_failure "$stage" "$message"
  ping_heartbeat fail "$message"
  exit 1
}

cleanup() {
  local code=$?
  rm -f "$SCRIPT_DIR/.rclone.conf.tmp" 2>/dev/null || true
  write_final_status
  exit "$code"
}
trap cleanup EXIT

echo "=== Libevra 完整备份 $(date '+%Y-%m-%d %H:%M:%S %Z') ==="
echo

# ---------------------------------------------------------------------------
# 1. 本地备份 + 隔离恢复演练
# ---------------------------------------------------------------------------
set +e
./backup.sh "${PASSTHROUGH[@]+"${PASSTHROUGH[@]}"}"
LOCAL_EXIT=$?
set -e

if [ -f "$LOCAL_STATUS" ]; then
  LOCAL_OK="$(grep -o '"localOk": *[a-z]*' "$LOCAL_STATUS" | grep -o 'true\|false' || echo false)"
  RESTORE_OK="$(grep -o '"restoreOk": *[a-z]*' "$LOCAL_STATUS" | grep -o 'true\|false' || echo false)"
fi

if [ "$LOCAL_EXIT" -ne 0 ] || [ "$LOCAL_OK" != "true" ]; then
  fail_stage "local" "本地备份失败（backup.sh 退出码 $LOCAL_EXIT）"
fi

echo
echo "✅ 本地备份通过（localOk=true，restoreOk=$RESTORE_OK）"

DUMP="$(grep -o '"dump": *"[^"]*"' "$LOCAL_STATUS" | sed 's/.*"dump": *"//; s/"$//')"
if [ -z "$DUMP" ] || [ ! -f "$BACKUP_DIR/$DUMP" ]; then
  fail_stage "local" "找不到刚生成的 dump（$DUMP）"
fi

# ---------------------------------------------------------------------------
# 2. 加密
# ---------------------------------------------------------------------------
if [ "$SKIP_OFFSITE" -eq 1 ]; then
  echo
  echo "→ 已按参数跳过异地（不加密、不上传）"
  ping_heartbeat ok
  echo
  echo "🎉 本地备份成功（异地未参与）。"
  exit 0
fi

if [ -z "${COS_UPLOAD_ID:-}" ] || [ -z "${COS_UPLOAD_KEY:-}" ] || [ -z "${COS_BUCKET:-}" ]; then
  echo
  echo "⚠️ **异地未配置**（deploy/.backup.env 缺 COS_UPLOAD_ID/COS_UPLOAD_KEY/COS_BUCKET）"
  echo "   本地备份有效，但它会随这台服务器一起消失。"
  FINAL_ERROR="异地未配置"
  ping_heartbeat fail "异地未配置"
  exit 0
fi
OFFSITE_CONFIGURED=true

if [ ! -f .backup.key ]; then
  fail_stage "encrypt" "缺少加密口令文件 deploy/.backup.key"
fi

# ⚠️ **对象名唯一**：时间戳 + 6 位随机。
# 时间戳到秒会撞（同一秒重跑），而 CAM 无法表达"禁止覆盖同名对象"——
# 唯一命名 + 版本控制是唯一可靠的两道保险。
RAND="$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n' | cut -c1-6)"
YEAR_MONTH="$(date -u +%Y/%m)"
BASE_NAME="${DUMP%.dump}-${RAND}"
ENCRYPTED="$BACKUP_DIR/${BASE_NAME}.dump.gpg"
REF="daily/${YEAR_MONTH}/${BASE_NAME}.dump.gpg"
OFFSITE_REF="$REF"

echo
echo "→ 加密（AES-256 + MDC 完整性校验，口令来自 .backup.key）…"
rm -f "$ENCRYPTED"
if ! gpg --batch --yes --quiet --pinentry-mode loopback \
      --passphrase-file .backup.key \
      --symmetric --cipher-algo AES256 \
      --output "$ENCRYPTED" "$BACKUP_DIR/$DUMP"; then
  fail_stage "encrypt" "gpg 加密失败"
fi

LOCAL_ENC_SIZE="$(stat -c%s "$ENCRYPTED" 2>/dev/null || echo 0)"
if [ "$LOCAL_ENC_SIZE" -lt 1024 ]; then
  fail_stage "encrypt" "加密文件只有 ${LOCAL_ENC_SIZE} 字节，异常"
fi
ENCRYPT_OK=true
echo "✅ 已加密：$(du -h "$ENCRYPTED" | cut -f1)"

# ---------------------------------------------------------------------------
# 3. 上传（上传身份：只有写权限）
# ---------------------------------------------------------------------------
RCLONE_CONF="$SCRIPT_DIR/.rclone.conf.tmp"
umask 077
cat > "$RCLONE_CONF" <<RCLONE
[cos]
type = s3
provider = Other
access_key_id = ${COS_UPLOAD_ID}
secret_access_key = ${COS_UPLOAD_KEY}
endpoint = ${COS_ENDPOINT:-cos.ap-hongkong.myqcloud.com}
region = ${COS_REGION:-ap-hongkong}
acl = private
no_check_bucket = true
force_path_style = false
RCLONE
chmod 600 "$RCLONE_CONF"

echo
echo "→ 上传到 COS：${REF}"
if ! rclone --config "$RCLONE_CONF" copyto --s3-no-check-bucket --retries 2 \
      "$ENCRYPTED" "cos:${COS_BUCKET}/${REF}" 2>&1; then
  OFFSITE_ERROR="上传 COS 失败"
  rm -f "$RCLONE_CONF"
  fail_stage "upload" "$OFFSITE_ERROR"
fi
UPLOAD_OK=true
echo "✅ 已上传"

# ---------------------------------------------------------------------------
# 4. 远端元数据校验（HeadObject；**不下载内容**，因为上传身份没有读权限）
# ---------------------------------------------------------------------------
echo "→ 远端校验（对象存在 + 大小一致）…"
REMOTE_JSON="$(rclone --config "$RCLONE_CONF" lsjson --stat "cos:${COS_BUCKET}/${REF}" 2>/dev/null || true)"
REMOTE_SIZE="$(printf '%s' "$REMOTE_JSON" | sed -n 's/.*"Size"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' | head -1)"
[ -z "$REMOTE_SIZE" ] && REMOTE_SIZE=0

if [ "${REMOTE_SIZE:-0}" != "$LOCAL_ENC_SIZE" ]; then
  rm -f "$RCLONE_CONF"
  OFFSITE_ERROR="远端大小不一致（本地 ${LOCAL_ENC_SIZE} / 远端 ${REMOTE_SIZE:-0}）"
  fail_stage "remote-meta" "$OFFSITE_ERROR"
fi
REMOTE_META_OK=true
echo "✅ 远端一致（${REMOTE_SIZE} 字节）"

# ---------------------------------------------------------------------------
# 5. **月度长期备份**（每月一份，独立前缀、独立更长保留期）
# ---------------------------------------------------------------------------
# ⚠️ **为什么必须有它**：`daily/` 的生命周期是"35 天后删除"，这是**按时间**算的，
# 与"备份是否成功"无关。如果连续 35 天备份都失败，`daily/` 会被全部清空 ——
# 而那 35 天里没有任何新备份可替换它们。**月度长期备份就是"没有新备份时仍然存在的那一份"。**
#
# 规则（简单、可验证）：
#   · **每月 1 日（香港时间）**那次成功备份，额外传一份到 `monthly/YYYY-MM/`；
#     若 1 日那次失败，则在**当月后续第一次成功运行**时补做（仍只留一份/月）；
#   · 名称仍带时间戳+随机，绝不覆盖；
#   · 生命周期：`monthly/` 保留 **365 天**（独立规则，不受 daily/ 影响）；
#   · 失败不会删除它；只有时间会（所以永远有一份一年内的月度长期）。
HKT_MONTH="$(TZ=Asia/Hong_Kong date '+%Y-%m')"
PREV_MONTHLY_MONTH="$(grep -o '"monthlyMonth"[[:space:]]*:[[:space:]]*"[^"]*"' "$STATUS_FILE" 2>/dev/null | head -1 | sed 's/.*"\([^"]*\)"$/\1/')"
MONTHLY_MONTH="${PREV_MONTHLY_MONTH:-}"
MONTHLY_REF=""

if [ "$PREV_MONTHLY_MONTH" != "$HKT_MONTH" ]; then
  MONTHLY_REF="monthly/${HKT_MONTH}/${BASE_NAME}.dump.gpg"
  echo "→ 本月尚无月度长期备份，额外上传一份：${MONTHLY_REF}"
  if rclone --config "$RCLONE_CONF" copyto --s3-no-check-bucket --retries 2 \
        "$ENCRYPTED" "cos:${COS_BUCKET}/${MONTHLY_REF}" 2>&1; then
    BASE_JSON="$(rclone --config "$RCLONE_CONF" lsjson --stat "cos:${COS_BUCKET}/${MONTHLY_REF}" 2>/dev/null || true)"
    BASE_SIZE="$(printf '%s' "$BASE_JSON" | sed -n 's/.*"Size"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' | head -1)"
    if [ "${BASE_SIZE:-0}" = "$LOCAL_ENC_SIZE" ]; then
      MONTHLY_MONTH="$HKT_MONTH"
      echo "✅ 月度长期备份已上传并校验（${BASE_SIZE} 字节，保留 365 天）"
    else
      # ⚠️ 月度长期备份失败**不让整次备份失败**：daily/ 那份已经成功了。
      # 但必须留下痕迹 —— 否则"以为有月度长期"比"知道没有月度长期"更危险。
      MONTHLY_REF=""
      echo "⚠️ 月度长期备份上传后大小不符，本次记为未完成月度长期备份" >&2
    fi
  else
    MONTHLY_REF=""
    echo "⚠️ 月度长期备份上传失败（daily 那份已成功，不影响本次结论）" >&2
  fi
  rm -f "$RCLONE_CONF"
else
  rm -f "$RCLONE_CONF"
  MONTHLY_REF="$(grep -o '"monthlyRef"[[:space:]]*:[[:space:]]*"[^"]*"' "$STATUS_FILE" 2>/dev/null | head -1 | sed 's/.*"\([^"]*\)"$/\1/')"
  echo "→ 本月已有月度长期备份（${HKT_MONTH}），不重复上传"
fi

# ---------------------------------------------------------------------------
# 6. 成功心跳（只有整条流程成功才发）
# ---------------------------------------------------------------------------
echo
ping_heartbeat ok

echo
echo "🎉 完整备份成功："
echo "   本地 ✅  恢复演练 $([ "$RESTORE_OK" = true ] && echo ✅ || echo '⚠️跳过')  加密 ✅  上传 ✅  远端校验 ✅"
[ "$HEARTBEAT_CONFIGURED" = true ] && echo "   心跳：$([ "$HEARTBEAT_OK" = true ] && echo ✅ || echo '⚠️ 发送失败')" || echo "   心跳：⚠️ 未配置"
echo "   ⚠️ 异地**内容**验证未做 —— 每月由 monthly-offsite-drill.sh 用恢复身份执行。"
echo "   对象：cos:${COS_BUCKET}/${REF}"
[ -n "$MONTHLY_REF" ] && echo "   月度长期备份：cos:${COS_BUCKET}/${MONTHLY_REF}（保留 365 天）"
exit 0
