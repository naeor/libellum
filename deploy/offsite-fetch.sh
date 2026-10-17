#!/usr/bin/env bash
#
# Libevra — 从 COS 取回一份异地备份并解密（**灾难恢复 / 月度演练用**）。
#
# ⚠️ **必须用"恢复身份"，不能用日常上传身份。**
#   · 日常上传身份**没有读权限**（设计如此）；
#   · 恢复身份**不常驻生产服务器** —— 它只在你自己的电脑或临时机器上使用。
#
# 凭据从环境变量或 `deploy/.backup-restore.env` 读：
#   COS_RESTORE_ID / COS_RESTORE_KEY / COS_BUCKET / COS_REGION / COS_ENDPOINT
#
# ⚠️ 它**只读**：下载 → 校验 → 解密，**不碰任何数据库**。
# 恢复数据库是下一步的人工决定（见运维手册 §15）。
#
# 用法：
#   ./offsite-fetch.sh --list                 # 列出云端备份（需要 GetBucket）
#   ./offsite-fetch.sh --ref daily/2026/10/xxx.dump.gpg
#   ./offsite-fetch.sh --latest               # 取最新一份
#   ./offsite-fetch.sh --latest --out /tmp/x  # 指定输出目录

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [ -f .backup-restore.env ]; then
  # shellcheck disable=SC1091
  set -a; . ./.backup-restore.env; set +a
fi

: "${COS_RESTORE_ID:?缺少恢复身份 COS_RESTORE_ID（应通过环境变量或 .backup-restore.env 提供，不要放在生产服务器上）}"
: "${COS_RESTORE_KEY:?缺少恢复身份 COS_RESTORE_KEY}"

# ⚠️ 防止有人图省事把上传身份当恢复身份用：上传身份没有读权限，用了也只是失败，
# 但更糟的是有人会因此去扩大上传身份的权限。明确挡掉。
if [ -n "${COS_UPLOAD_ID:-}" ] && [ "$COS_RESTORE_ID" = "$COS_UPLOAD_ID" ]; then
  echo "❌ 恢复身份与上传身份是同一个 —— 这违反最小权限设计。" >&2
  echo "   请用 CAM 里单独创建的恢复身份（只读）。" >&2
  exit 1
fi

if [ ! -f .backup.key ]; then
  echo "❌ 找不到 .backup.key —— 有备份也解不开。" >&2
  echo "   它应在你的敏感信息目录里；恢复时临时放到本目录或通过环境变量指向。" >&2
  exit 1
fi

MODE="fetch"
REF=""
OUT_DIR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --list) MODE="list" ;;
    --latest) MODE="latest" ;;
    --ref) REF="${2:?--ref needs a value}"; MODE="fetch"; shift ;;
    --out) OUT_DIR="${2:?--out needs a value}"; shift ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
  shift
done

RCLONE_CONF="$(mktemp)"
trap 'rm -f "$RCLONE_CONF"' EXIT
umask 077
cat > "$RCLONE_CONF" <<RCLONE
[cos]
type = s3
provider = Other
access_key_id = ${COS_RESTORE_ID}
secret_access_key = ${COS_RESTORE_KEY}
endpoint = ${COS_ENDPOINT:-cos.ap-hongkong.myqcloud.com}
region = ${COS_REGION:-ap-hongkong}
acl = private
no_check_bucket = true
RCLONE

if [ "$MODE" = "list" ]; then
  echo "=== 云端备份（新到旧） ==="
  rclone --config "$RCLONE_CONF" lsf --files-only "cos:${COS_BUCKET}/daily/" | sort -r | sed 's/^/  /'
  exit 0
fi

if [ "$MODE" = "latest" ] || [ -z "$REF" ]; then
  REF="$(rclone --config "$RCLONE_CONF" lsf --files-only "cos:${COS_BUCKET}/daily/" | sort -r | head -1)"
  if [ -z "$REF" ]; then
    echo "❌ 云端没有备份。" >&2
    exit 1
  fi
fi

OUT_DIR="${OUT_DIR:-$SCRIPT_DIR/backups/restored}"
mkdir -p "$OUT_DIR"
NAME="$(basename "$REF")"
ENC="$OUT_DIR/$NAME"

echo "→ 下载 cos:${COS_BUCKET}/${REF}"
rclone --config "$RCLONE_CONF" copyto "cos:${COS_BUCKET}/${REF}" "$ENC"
echo "✅ 已下载：$ENC（$(du -h "$ENC" | cut -f1)）"

echo "→ 校验能否解密（不落明文，只试）…"
if ! gpg --batch --quiet --pinentry-mode loopback \
      --passphrase-file .backup.key --decrypt "$ENC" > /dev/null 2>&1; then
  echo "❌ 解密失败：口令不对（.backup.key 与加密时不是同一份）或文件损坏。" >&2
  exit 1
fi
echo "✅ 口令正确，文件可解密"

DUMP="$OUT_DIR/${NAME%.gpg}"
gpg --batch --yes --quiet --pinentry-mode loopback \
    --passphrase-file .backup.key --decrypt --output "$DUMP" "$ENC"

echo "✅ 已解密：$DUMP"
echo
echo "下一步："
echo "  · 月度演练 / 灾难恢复验证：./verify-dump.sh \"$DUMP\" --expect backups/last-local.json"
echo "  · 真要救命（**会重建目标库，只在空环境执行**）：./restore.sh \"$DUMP\" --yes"
