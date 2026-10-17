#!/usr/bin/env bash
#
# Libevra — **一次完整的备份**：本地备份与恢复演练 → 加密 → 上传异地 → 下载回来校验 → 写状态 → 失败告警。
#
# ⚠️ **为什么这是单独一层，而不是塞进 `backup.sh`。**
#
# `backup.sh` 回答的是"本地这份能不能恢复"；这个脚本回答的是"它到别处去了吗"。
# 两件事失败的原因完全不同（磁盘满 vs 网络/密钥错），**混在一个脚本里会让失败原因变模糊**，
# 而这个项目对"一个报错说不清是哪一步"的代价记得很清楚。
#
# 状态分三项，**绝不合并成一个"备份正常"**：
#
#   localOk    本地导出成功（文件存在、大小合理、归档可解析）
#   restoreOk  隔离恢复演练通过（逐表行数一致）
#   offsiteOk  异地：上传成功 **且** 下载回来比对 SHA-256 一致
#
# 用法：
#
#   ./deploy/backup-all.sh                    # 完整流程（定时任务跑这个）
#   ./deploy/backup-all.sh --skip-offsite     # 只做本地（异地未配置时也能跑）
#   ./deploy/backup-all.sh --keep 14
#
# ⚠️ **需要三个秘密文件，全部在 deploy/ 下、权限 600、不进仓库：**
#
#   .backup.key          加密口令（openssl rand -base64 32）
#   .backup.env          COS_SECRET_ID / COS_SECRET_KEY / COS_BUCKET / COS_REGION / COS_ENDPOINT
#   .backup-notify.env   TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID（可选）
#
# ⚠️ **异地的删除权限根本不在这个脚本里。** 上传用的子账号没有 `DeleteObject`，
# 30 天过期由**桶的生命周期规则**在服务端完成 —— 即使服务器被入侵、密钥被读走，
# 历史备份也删不掉。这是设计，不是疏忽。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

BACKUP_DIR="$SCRIPT_DIR/backups"
mkdir -p "$BACKUP_DIR"

STATUS_FILE="$BACKUP_DIR/last-run.json"
LOCAL_STATUS="$BACKUP_DIR/last-local.json"
LOCK_FILE="$SCRIPT_DIR/.backup.lock"

SKIP_OFFSITE=0
KEEP_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --skip-offsite) SKIP_OFFSITE=1 ;;
    --keep) KEEP_ARGS=(--keep "${2:?--keep needs a number}"); shift ;;
    --no-restore-drill) KEEP_ARGS+=(--no-restore-drill) ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
  shift
done

# ---------------------------------------------------------------------------
# 并发保护：同一时刻只允许一次
# ---------------------------------------------------------------------------
# ⚠️ systemd 同一个 service 本来就不会并发启动，但**手动跑一次**是很常见的动作，
# 而两次同时跑会各自占一份磁盘和连接。`flock` 让第二次直接退出而不是排队。
exec 9> "$LOCK_FILE"
if ! flock -n 9; then
  echo "❌ 已经有一次备份在运行（$LOCK_FILE 被占用）。本次退出。" >&2
  exit 0
fi

STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
FINAL_ERROR=""
OFFSITE_CONFIGURED=false
OFFSITE_OK=false
OFFSITE_REF=""
NOTIFY_ENABLED=false
NOTIFY_SENT=false
LOCAL_OK=false
RESTORE_OK=false

# ---------------------------------------------------------------------------
# 载入秘密（缺失不报错：它们可能还没配置）
# ---------------------------------------------------------------------------
if [ -f .backup.env ]; then
  # shellcheck disable=SC1091
  set -a; . ./.backup.env; set +a
fi
if [ -f .backup-notify.env ]; then
  # shellcheck disable=SC1091
  set -a; . ./.backup-notify.env; set +a
fi

PASSPHRASE_FILE="$SCRIPT_DIR/.backup.key"

write_final_status() {
  local finished_at
  finished_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  # 本地那一半从 backup.sh 的状态文件里取（它才是当事人）。
  local local_json="{}"
  if [ -f "$LOCAL_STATUS" ]; then
    local_json="$(cat "$LOCAL_STATUS")"
  fi

  cat > "$STATUS_FILE.tmp" <<JSON
{
  "kind": "full",
  "startedAt": "$STARTED_AT",
  "finishedAt": "$finished_at",
  "local": $local_json,
  "offsite": {
    "configured": $OFFSITE_CONFIGURED,
    "ok": $OFFSITE_OK,
    "ref": "$OFFSITE_REF"
  },
  "notify": {
    "enabled": $NOTIFY_ENABLED,
    "sent": $NOTIFY_SENT
  },
  "error": $(if [ -n "$FINAL_ERROR" ]; then printf '"%s"' "$(printf '%s' "$FINAL_ERROR" | tr -d '"' | tr '\n' ' ')"; else printf 'null'; fi)
}
JSON
  mv "$STATUS_FILE.tmp" "$STATUS_FILE"
}

# ---------------------------------------------------------------------------
# 告警（Telegram）—— **没配置就是没配置，不会假装成功**
# ---------------------------------------------------------------------------
notify() {
  local outcome="$1" message="$2"

  if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ]; then
    NOTIFY_ENABLED=true
    if curl -sS --max-time 20 -o /dev/null \
      "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
      --data-urlencode "text=${message}" \
      --data "" >/dev/null 2>&1; then
      NOTIFY_SENT=true
      echo "（已发送 Telegram 告警：$outcome）"
    else
      echo "⚠️ 告警发送失败（Telegram 请求失败）" >&2
    fi
  else
    echo "⚠️ 通知未启用：deploy/.backup-notify.env 里没有 TELEGRAM_BOT_TOKEN/CHAT_ID"
  fi
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
# 第一步：本地备份 + 恢复演练
# ---------------------------------------------------------------------------
set +e
./backup.sh "${KEEP_ARGS[@]+"${KEEP_ARGS[@]}"}"
LOCAL_EXIT=$?
set -e

if [ -f "$LOCAL_STATUS" ]; then
  LOCAL_OK="$(grep -o '"localOk": *[a-z]*' "$LOCAL_STATUS" | grep -o 'true\|false' || echo false)"
  RESTORE_OK="$(grep -o '"restoreOk": *[a-z]*' "$LOCAL_STATUS" | grep -o 'true\|false' || echo false)"
fi

if [ "$LOCAL_EXIT" -ne 0 ] || [ "$LOCAL_OK" != "true" ]; then
  FINAL_ERROR="本地备份失败（backup.sh 退出码 $LOCAL_EXIT）"
  echo "❌ $FINAL_ERROR" >&2
  notify "失败" "Libevra 备份失败：本地备份没通过。详见服务器 journalctl -u libevra-backup。"
  exit 1
fi

echo
echo "✅ 本地备份通过（localOk=true，restoreOk=$RESTORE_OK）"

# ---------------------------------------------------------------------------
# 第二步：加密 + 上传 + 下载回来校验
# ---------------------------------------------------------------------------
if [ "$SKIP_OFFSITE" -eq 1 ]; then
  echo
  echo "→ 已按参数跳过异地（--skip-offsite）"
elif [ -z "${COS_SECRET_ID:-}" ] || [ -z "${COS_SECRET_KEY:-}" ] || [ -z "${COS_BUCKET:-}" ]; then
  echo
  echo "⚠️ **异地未配置**（deploy/.backup.env 缺少 COS_* 或 .backup.key）"
  echo "   这不是失败：本地备份仍然有效，但**这台服务器上的这一份会随服务器一起消失**。"
  FINAL_ERROR="异地未配置"
elif [ ! -f "$PASSPHRASE_FILE" ]; then
  FINAL_ERROR="缺少加密口令文件 deploy/.backup.key"
  echo "❌ $FINAL_ERROR" >&2
  notify "失败" "Libevra 备份失败：缺少加密口令，异地备份没有做。"
  exit 1
else
  OFFSITE_CONFIGURED=true

  DUMP="$(grep -o '"dump": *"[^"]*"' "$LOCAL_STATUS" | sed 's/.*"dump": *"//; s/"$//')"
  SHA_LOCAL="$(grep -o '"sha256": *"[^"]*"' "$LOCAL_STATUS" | sed 's/.*"sha256": *"//; s/"$//')"

  if [ -z "$DUMP" ] || [ ! -f "$BACKUP_DIR/$DUMP" ]; then
    FINAL_ERROR="找不到刚生成的 dump（$DUMP）"
    echo "❌ $FINAL_ERROR" >&2
    exit 1
  fi

  ENCRYPTED="$BACKUP_DIR/${DUMP%.dump}.dump.gpg"
  REF="daily/${DUMP%.dump}.dump.gpg"
  OFFSITE_REF="$REF"

  echo
  echo "→ 加密（AES-256，口令来自 .backup.key）…"
  rm -f "$ENCRYPTED"
  gpg --batch --yes --quiet --pinentry-mode loopback \
      --passphrase-file "$PASSPHRASE_FILE" \
      --symmetric --cipher-algo AES256 \
      --output "$ENCRYPTED" "$BACKUP_DIR/$DUMP"

  SHA_ENC="$(sha256sum "$ENCRYPTED" | cut -d' ' -f1)"
  echo "✅ 已加密：$(du -h "$ENCRYPTED" | cut -f1)（sha256 ${SHA_ENC:0:16}…）"

  # rclone 配置写在临时文件里，用完即删 —— **不新建第四个秘密文件**。
  # 它的内容来自 .backup.env，600 权限，脚本退出时删除。
  RCLONE_CONF="$SCRIPT_DIR/.rclone.conf.tmp"
  umask 077
  cat > "$RCLONE_CONF" <<RCLONE
[cos]
type = s3
provider = Other
access_key_id = ${COS_SECRET_ID}
secret_access_key = ${COS_SECRET_KEY}
endpoint = ${COS_ENDPOINT:-cos.ap-hongkong.myqcloud.com}
region = ${COS_REGION:-ap-hongkong}
acl = private
no_check_bucket = true
RCLONE
  chmod 600 "$RCLONE_CONF"

  echo "→ 上传到 COS…"
  if ! rclone --config "$RCLONE_CONF" copyto --s3-no-check-bucket \
      "$ENCRYPTED" "cos:${COS_BUCKET}/${REF}" 2>&1; then
    FINAL_ERROR="上传 COS 失败"
    echo "❌ $FINAL_ERROR" >&2
    rm -f "$RCLONE_CONF"
    notify "失败" "Libevra 备份失败：本地成功，但**上传异地失败**。本地那份仍然可用。"
    exit 1
  fi
  echo "✅ 已上传：cos:${COS_BUCKET}/${REF}"

  echo "→ 从 COS 下载回来校验（证明异地那份真的能取回、且内容一致）…"
  VERIFY_DL="$(mktemp)"
  if ! rclone --config "$RCLONE_CONF" copyto "cos:${COS_BUCKET}/${REF}" "$VERIFY_DL" 2>&1; then
    FINAL_ERROR="从 COS 下载校验失败"
    echo "❌ $FINAL_ERROR" >&2
    rm -f "$RCLONE_CONF" "$VERIFY_DL"
    notify "失败" "Libevra 备份失败：上传显示成功，但**下载回来失败**。异地那份不可信。"
    exit 1
  fi

  SHA_REMOTE="$(sha256sum "$VERIFY_DL" | cut -d' ' -f1)"
  rm -f "$VERIFY_DL" "$RCLONE_CONF"

  if [ "$SHA_REMOTE" != "$SHA_ENC" ]; then
    FINAL_ERROR="异地校验不一致（本地 $SHA_ENC / 异地 $SHA_REMOTE）"
    echo "❌ $FINAL_ERROR" >&2
    notify "失败" "Libevra 备份失败：异地文件与本地不一致，异地那份不可信。"
    exit 1
  fi

  OFFSITE_OK=true
  echo "✅ 异地校验通过（SHA-256 一致）"
  echo "   本地明文 sha256 = $SHA_LOCAL"
  # 加密副本只是上传的中转，本地留明文 dump 即可（省一半空间）。
  rm -f "$ENCRYPTED"
fi

# ---------------------------------------------------------------------------
# 第三步：写数据库（表存在才写；不存在就等 S13 迁移）
# ---------------------------------------------------------------------------
if [ -f .env ]; then
  # shellcheck disable=SC1091
  set -a; . ./.env; set +a
  HAS_TABLE="$(docker compose -f docker-compose.prod.yml exec -T db \
    env PGPASSWORD="${POSTGRES_PASSWORD:-}" \
    psql -U "${POSTGRES_USER:-}" -d "${POSTGRES_DB:-}" -tAc \
    "select to_regclass('public.backup_logs') is not null" 2>/dev/null | tr -d ' ' || echo "f")"

  if [ "$HAS_TABLE" = "t" ]; then
    # 用 json 拼一条 INSERT，避免把 json 引号写进 SQL 字符串。
    docker compose -f docker-compose.prod.yml exec -T db \
      env PGPASSWORD="${POSTGRES_PASSWORD:-}" \
      psql -U "${POSTGRES_USER:-}" -d "${POSTGRES_DB:-}" -q -c \
      "insert into backup_logs (started_at, finished_at, ok, local_ok, restore_ok, offsite_ok, file_ref, note)
       values ('$STARTED_AT', now(), $([ "$LOCAL_OK" = true ] && [ "$OFFSITE_OK" = true ] && echo true || echo false),
               $LOCAL_OK, $RESTORE_OK, $OFFSITE_OK,
               nullif('${OFFSITE_REF}',''), nullif('${FINAL_ERROR}',''))" 2>/dev/null \
      && echo "→ 已写入 backup_logs（管理后台概览会显示）" \
      || echo "⚠️ 写入 backup_logs 失败（不影响备份本身）"
  else
    echo "→ 跳过写 database（backup_logs 表还不存在 —— 等 S13 迁移部署后再启用）"
  fi
fi

# ---------------------------------------------------------------------------
# 第四步：告警策略
# ---------------------------------------------------------------------------
# ⚠️ **只在失败时发**：每天一条"备份成功"的消息，两周后就会被无视 ——
# 而告警被无视时，真正的失败也就没人看了。
if [ "$LOCAL_OK" = true ] && [ "$OFFSITE_OK" = true ]; then
  echo
  echo "🎉 完整备份成功：本地 ✅ 恢复演练 $([ "$RESTORE_OK" = true ] && echo ✅ || echo '⚠️ 跳过') 异地 ✅"
fi

if [ "$OFFSITE_CONFIGURED" = false ]; then
  echo
  echo "⚠️ **异地备份尚未配置** —— 本次只完成了本地备份。"
  echo "   配置后这个脚本会自动开始上传；在此之前，管理后台概览里异地状态会显示为未配置。"
fi

exit 0
