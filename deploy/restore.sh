#!/usr/bin/env bash
#
# Libevra — 从备份恢复整个数据库。
#
# ⚠️⚠️ **这是本仓库里最危险的一个脚本。** 它**会覆盖生产数据库**。
# 它存在的理由同样重要：**一个没有恢复路径的备份不是备份。**
#
# ⚠️ **它要求你把备份文件名完整打出来，而不是选一个编号。**
# 恢复错备份等于用一份旧数据覆盖新数据，而"我以为是昨天那份"是这类事故的标准开场。
#
# ⚠️ **它默认不删除现有库，而是重建它。** `dropdb` + `createdb` + `pg_restore`。
# 这**会丢掉备份之后产生的所有数据**——这正是"恢复"的含义，但值得说清楚。
#
# ⚠️ **它先做一个安全副本。** 覆盖之前，把当前库再导出一份到 `backups/pre-restore-*.dump`。
# 那是"我恢复错了，想回去"的唯一出路，而且它几乎不花时间。
#
# 用法（在服务器上，仓库目录里）：
#
#   ./deploy/restore.sh backups/libevra_prod-20261014-120000.dump
#   ./deploy/restore.sh backups/....dump --yes       # 跳过确认（自动化用）
#
# ⚠️ **恢复之后要重启 API** ——连接池里是旧连接，而且 schema 可能变了。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

COMPOSE=(docker compose -f docker-compose.prod.yml)

DUMP="${1:-}"
CONFIRMED=0
[ "${2:-}" = "--yes" ] && CONFIRMED=1

if [ -z "$DUMP" ] || [ ! -f "$DUMP" ]; then
  echo "❌ 用法：./deploy/restore.sh <备份文件路径>" >&2
  echo "   可用备份：" >&2
  ls -lh backups/*.dump 2>/dev/null | awk '{print "     " $9 "  " $5}' >&2 || echo "     （无）" >&2
  exit 2
fi

if [ ! -f ".env" ]; then
  echo "❌ 找不到 deploy/.env" >&2
  exit 1
fi

# shellcheck disable=SC1090
set -a; . ./.env; set +a
: "${POSTGRES_USER:?}"; : "${POSTGRES_PASSWORD:?}"; : "${POSTGRES_DB:?}"

echo "=== Libevra 恢复 ==="
echo "备份文件：$DUMP"
echo "目标库  ：$POSTGRES_DB"
echo
echo "⚠️ **这会覆盖 $POSTGRES_DB 的全部内容。**"
echo "   备份之后产生的一切都会消失——包括账目。"
echo

if [ "$CONFIRMED" -ne 1 ]; then
  read -r -p '输入 yes（全小写）继续： ' REPLY
  [ "$REPLY" = "yes" ] || { echo "已取消。"; exit 1; }
fi

echo
echo "→ 安全副本：先把当前库导出…"
SAFETY="backups/pre-restore-$(date +%Y%m%d-%H%M%S).dump"
mkdir -p backups
"${COMPOSE[@]}" exec -T db \
  env PGPASSWORD="$POSTGRES_PASSWORD" \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc > "$SAFETY"
echo "✅ 当前状态已存到 $SAFETY"
echo "   （如果恢复错了，这就是回去的路。）"
echo

echo "→ 停 API（断开连接，否则 dropdb 会被占用挡住）…"
"${COMPOSE[@]}" stop api >/dev/null

echo "→ 重建数据库…"
"${COMPOSE[@]}" exec -T db \
  env PGPASSWORD="$POSTGRES_PASSWORD" \
  dropdb -U "$POSTGRES_USER" --if-exists "$POSTGRES_DB"
"${COMPOSE[@]}" exec -T db \
  env PGPASSWORD="$POSTGRES_PASSWORD" \
  createdb -U "$POSTGRES_USER" "$POSTGRES_DB"

echo "→ 恢复…"
"${COMPOSE[@]}" exec -T db \
  env PGPASSWORD="$POSTGRES_PASSWORD" \
  pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --exit-on-error < "$DUMP"
echo "✅ 已恢复"

echo "→ 重启 API…"
"${COMPOSE[@]}" up -d api >/dev/null

echo "→ 健康检查…"
for i in $(seq 1 30); do
  if "${COMPOSE[@]}" exec -T api \
      node -e "fetch('http://127.0.0.1:3000/api/v1/health').then(r=>r.json()).then(j=>process.exit(j.ok&&j.database==='up'?0:1)).catch(()=>process.exit(1))" \
      >/dev/null 2>&1; then
    echo
    echo "✅ 恢复完成，API 健康。"
    echo
    echo "⚠️ 三件恢复之后一定要做的事："
    echo "   1. **确认账目数量是对的** —— 恢复「成功」和恢复「对」是两件事；"
    echo "   2. **跑一次 ./deploy/backup.sh** —— 现在的库还没有被验证过的备份；"
    echo "   3. **检查管理员**：DB 里恢复了旧授权记录，确认只有该有的人在名单上 ——"
    echo "      见 docs/管理员与权限边界-设计决定.md §7。"
    exit 0
  fi
  sleep 2
done

echo
echo "❌ API 没有起来。数据库已恢复，但服务不健康。" >&2
echo "   排查：${COMPOSE[*]} logs api --tail 50" >&2
echo "   回退到刚才的安全副本：$SAFETY" >&2
exit 1
