#!/usr/bin/env bash
#
# Libevra — **验证一份 dump 能真正恢复**（隔离临时库，绝不碰现有库）。
#
# 用途：
#   · 月度异地演练：把从 COS 取回并解密的那份 dump 拿来验证；
#   · 灾后：在新服务器上确认"手里这份能恢复"再决定是否动真正的库。
#
# ⚠️ **它只建/删自己的临时库**（`libevra_verify_*`），**绝不 drop 任何已存在的库**。
# 这一点和 `restore.sh` 完全不同 —— 后者会重建生产库，只该在救命时人工跑。
#
# ⚠️ **对照物从哪来**：生产库可能已经不存在了，所以不能"和源库比"。
# 改为和 `--expect <json>` 里记录的**每张表行数**比 —— 那是备份当时记下的数字
# （`backups/last-local.json` 的 `tableCounts`）。
#
# 用法（在能连到 PostgreSQL 的机器上）：
#   ./verify-dump.sh /path/to/xxx.dump --expect backups/last-local.json
#   ./verify-dump.sh /path/to/xxx.dump                 # 只验证"能恢复 + 表齐全"

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

DUMP=""
EXPECT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --expect) EXPECT="${2:?--expect needs a file}"; shift ;;
    *) DUMP="$1" ;;
  esac
  shift
done

if [ -z "$DUMP" ] || [ ! -f "$DUMP" ]; then
  echo "❌ 用法：./verify-dump.sh <dump 文件> [--expect last-local.json]" >&2
  exit 2
fi

if [ ! -f .env ]; then
  echo "❌ 找不到 deploy/.env —— 不知道连哪个 PostgreSQL。" >&2
  exit 1
fi
# shellcheck disable=SC1091
set -a; . ./.env; set +a
: "${POSTGRES_USER:?}"; : "${POSTGRES_PASSWORD:?}"; : "${POSTGRES_DB:?}"

DC="docker compose -f docker-compose.prod.yml"
VERIFY_DB="libevra_verify_$(date +%Y%m%d-%H%M%S)_$RANDOM"
FAILED=0

drop_verify() {
  $DC exec -T db env PGPASSWORD="$POSTGRES_PASSWORD" \
    dropdb -U "$POSTGRES_USER" --if-exists "$VERIFY_DB" >/dev/null 2>&1 || true
}
trap drop_verify EXIT

echo "=== 验证 dump：$(basename "$DUMP") ==="
echo "临时库：$VERIFY_DB（验证完立刻删除）"
echo

echo "→ 归档可解析…"
TOC="$($DC exec -T db pg_restore --list < "$DUMP" | grep -c ';' || true)"
if [ "${TOC:-0}" -lt 10 ]; then
  echo "❌ 归档只有 ${TOC:-0} 个条目，文件不可用。" >&2
  exit 1
fi
echo "✅ $TOC 个条目"

echo "→ 建临时库并恢复…"
$DC exec -T db env PGPASSWORD="$POSTGRES_PASSWORD" createdb -U "$POSTGRES_USER" "$VERIFY_DB"
$DC exec -T db env PGPASSWORD="$POSTGRES_PASSWORD" \
  pg_restore -U "$POSTGRES_USER" -d "$VERIFY_DB" --exit-on-error < "$DUMP"
echo "✅ 恢复成功"

echo "→ 表清单…"
TABLES="$($DC exec -T db env PGPASSWORD="$POSTGRES_PASSWORD" \
  psql -U "$POSTGRES_USER" -d "$VERIFY_DB" -tAc \
  "select table_name from information_schema.tables where table_schema='public' order by 1")"
COUNT_TABLES="$(printf '%s\n' "$TABLES" | grep -c . || true)"
echo "  共 $COUNT_TABLES 张表"
for REQUIRED in users books transactions book_members admin_grants admin_allowlist _prisma_migrations; do
  if ! printf '%s\n' "$TABLES" | grep -qx "$REQUIRED"; then
    echo "  ❌ 缺少关键表：$REQUIRED"
    FAILED=1
  fi
done

if [ -n "$EXPECT" ]; then
  if [ ! -f "$EXPECT" ]; then
    echo "❌ 对照文件不存在：$EXPECT" >&2
    exit 1
  fi
  echo "→ 与备份时记录的行数对照（$EXPECT）…"
  while IFS= read -r ROW; do
    T="${ROW%%=*}"; WANT="${ROW#*=}"
    [ -z "$T" ] && continue
    GOT="$($DC exec -T db env PGPASSWORD="$POSTGRES_PASSWORD" \
      psql -U "$POSTGRES_USER" -d "$VERIFY_DB" -tAc "select count(*) from \"$T\"" 2>/dev/null || echo "missing")"
    if [ "$GOT" != "$WANT" ]; then
      echo "  ❌ $T：期望 $WANT / 实际 $GOT"
      FAILED=1
    fi
  done < <(grep -o '"[A-Za-z_][A-Za-z0-9_]*"[[:space:]]*:[[:space:]]*[0-9][0-9]*' "$EXPECT" \
             | sed 's/"\([^"]*\)"[[:space:]]*:[[:space:]]*\([0-9]*\)/\1=\2/')
fi

if [ "$FAILED" -ne 0 ]; then
  echo
  echo "❌ 验证失败：这份备份不能拿去救命。" >&2
  exit 1
fi

echo
echo "🎉 验证通过：归档完整、恢复成功、关键表齐全$([ -n "$EXPECT" ] && echo '、行数与备份时一致')。"
