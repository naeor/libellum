#!/usr/bin/env bash
#
# Libevra — 从 COS 取回一份异地备份并解密（**灾难恢复用，平时不跑**）。
#
# ⚠️ 它**只读**：下载 → 校验 → 解密到指定目录，**不碰任何数据库**。
# 恢复数据库是下一步的人工决定（见运维手册 §15）。
#
# 用法：
#   ./deploy/offsite-fetch.sh --list                 # 列出云端有哪些备份
#   ./deploy/offsite-fetch.sh                        # 取最新一份，解密到 backups/restored/
#   ./deploy/offsite-fetch.sh --ref daily/xxx.gpg    # 取指定一份
#
# 需要的秘密：deploy/.backup.env（COS 凭据）+ deploy/.backup.key（加密口令）。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

: "${COS_SECRET_ID:?缺少 deploy/.backup.env 里的 COS_SECRET_ID}"
# 上面那行只是给 shellcheck 一个信号；真正的加载在下面。
unset COS_SECRET_ID

if [ ! -f .backup.env ]; then
  echo "❌ 找不到 deploy/.backup.env —— 不知道去哪个桶取。" >&2
  exit 1
fi
# shellcheck disable=SC1091
set -a; . ./.backup.env; set +a

if [ ! -f .backup.key ]; then
  echo "❌ 找不到 deploy/.backup.key —— 有备份也解不开。" >&2
  exit 1
fi

RCLONE_CONF="$(mktemp)"
trap 'rm -f "$RCLONE_CONF"' EXIT
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

MODE="fetch"
REF=""
while [ $# -gt 0 ]; do
  case "$1" in
    --list) MODE="list" ;;
    --ref) REF="${2:?--ref needs a value}"; shift ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
  shift
done

if [ "$MODE" = "list" ]; then
  echo "=== 云端备份（新到旧） ==="
  rclone --config "$RCLONE_CONF" lsf --files-only "cos:${COS_BUCKET}/daily/" | sort -r | sed 's/^/  /'
  exit 0
fi

if [ -z "$REF" ]; then
  REF="daily/$(rclone --config "$RCLONE_CONF" lsf --files-only "cos:${COS_BUCKET}/daily/" | sort -r | head -1)"
  if [ "$REF" = "daily/" ]; then
    echo "❌ 云端没有备份。" >&2
    exit 1
  fi
fi

OUT_DIR="$SCRIPT_DIR/backups/restored"
mkdir -p "$OUT_DIR"
NAME="$(basename "$REF")"
ENC="$OUT_DIR/$NAME"

echo "→ 下载 cos:${COS_BUCKET}/${REF} …"
rclone --config "$RCLONE_CONF" copyto "cos:${COS_BUCKET}/${REF}" "$ENC"
echo "✅ 已下载：$ENC（$(du -h "$ENC" | cut -f1)）"

echo "→ 校验能否解密（不产生明文，只试）…"
if ! gpg --batch --quiet --pinentry-mode loopback \
      --passphrase-file .backup.key --decrypt "$ENC" > /dev/null 2>&1; then
  echo "❌ 解密失败。可能是口令不对（.backup.key 与加密时不是同一份），或文件损坏。" >&2
  exit 1
fi
echo "✅ 口令正确，文件可解密"

DUMP="$OUT_DIR/${NAME%.gpg}"
gpg --batch --yes --quiet --pinentry-mode loopback \
    --passphrase-file .backup.key --decrypt --output "$DUMP" "$ENC"

echo "✅ 已解密：$DUMP"
echo
echo "下一步（人工决定，不要自动执行）："
echo "  1. 确认要恢复到哪个环境（**绝不覆盖生产库来演练**）"
echo "  2. 隔离演练：见 docs/生产环境与运维手册.md §15"
echo "  3. 真要救命：./deploy/restore.sh $DUMP --yes"
