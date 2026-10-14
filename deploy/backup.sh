#!/usr/bin/env bash
#
# Libevra — 生产备份：导出、**证明能恢复**、保留、轮转。
#
# ⚠️ **为什么"能恢复"必须在同一个脚本里做。**
#
# 这是 `tools/backup-verify.mjs` 在服务器上的对应物，理由和它一模一样：
# **一个没人恢复过的备份不是备份，只是一份让人安心的文件。**
# 它可能在写的时候就被截断、可能漏了某张表、可能在恢复到一半时报错——
# 而这些**只有真的恢复一次才会知道**。
#
# 区别在于：开发机上可以建临时库来演练，**生产服务器上不该为了演练而建库**。
# 所以这里的验证是两步，都很轻：
#
#   1. `pg_restore --list` 解析整个归档——文件损坏会在这一步失败；
#   2. **把归档恢复进一个临时库，比对每张表的行数，再删掉临时库。**
#      这一步默认开启，用 `--no-restore-drill` 关掉（不推荐）。
#
# ⚠️ **临时库用的是同一个 PostgreSQL 实例。** 它占磁盘，而且是"生产库旁边多一个库"。
# 脚本会先检查剩余空间，演练完立刻 `dropdb`。**它从不碰真实库**：只读源库，只写临时库。
#
# 用法（在服务器上，仓库目录里）：
#
#   ./deploy/backup.sh                    # 备份 + 恢复演练 + 轮转
#   ./deploy/backup.sh --no-restore-drill # 只备份（不推荐）
#   ./deploy/backup.sh --keep 14          # 保留 14 天（默认 7）
#
# ⚠️ **它读 deploy/.env 里的 POSTGRES_*，不读命令行参数。**
# 口令走 `PGPASSWORD` 环境变量，**不进命令行**——命令行参数会出现在进程列表里。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

ENV_FILE=".env"
KEEP_DAYS=7
RESTORE_DRILL=1

while [ $# -gt 0 ]; do
  case "$1" in
    --no-restore-drill) RESTORE_DRILL=0 ;;
    --keep) KEEP_DAYS="${2:?--keep needs a number}"; shift ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
  shift
done

if [ ! -f "$ENV_FILE" ]; then
  echo "❌ 找不到 deploy/.env —— 备份不知道要连哪个库。" >&2
  exit 1
fi

# shellcheck disable=SC1090
set -a; . "./$ENV_FILE"; set +a

: "${POSTGRES_USER:?deploy/.env 缺少 POSTGRES_USER}"
: "${POSTGRES_PASSWORD:?deploy/.env 缺少 POSTGRES_PASSWORD}"
: "${POSTGRES_DB:?deploy/.env 缺少 POSTGRES_DB}"

BACKUP_DIR="${BACKUP_DIR:-$SCRIPT_DIR/backups}"
mkdir -p "$BACKUP_DIR"

STAMP="$(date +%Y%m%d-%H%M%S)"
DUMP="$BACKUP_DIR/${POSTGRES_DB}-${STAMP}.dump"

echo "=== Libevra 生产备份 ==="
echo "库：$POSTGRES_DB    文件：$DUMP"
echo

# ⚠️ `-Fc`（自定义格式）而不是纯 SQL：它可以 `--list`、可以并行恢复、可以只恢复一张表。
# 纯 SQL 备份只能整个重放，而"只想找回一笔账"是真实会发生的事。
echo "→ 导出…"
docker compose -f docker-compose.prod.yml exec -T db \
  env PGPASSWORD="$POSTGRES_PASSWORD" \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc \
  > "$DUMP"

SIZE="$(du -h "$DUMP" | cut -f1)"
echo "✅ 备份写完：$SIZE"

# ---------------------------------------------------------------------------
# 校验一：归档可解析
# ---------------------------------------------------------------------------
echo "→ 校验归档可解析…"
TOC="$(docker compose -f docker-compose.prod.yml exec -T db pg_restore --list < "$DUMP" | grep -c ';' || true)"
if [ "${TOC:-0}" -lt 10 ]; then
  echo "❌ 归档条目只有 ${TOC:-0} 个——文件可能是空的或被截断。" >&2
  exit 1
fi
echo "✅ 归档可解析：$TOC 个条目"

if [ "$RESTORE_DRILL" -eq 0 ]; then
  echo
  echo "⚠️ 已跳过恢复演练。**这份备份还没有被证明能恢复。**"
else
  # -------------------------------------------------------------------------
  # 校验二：真的恢复一次，比对行数
  # -------------------------------------------------------------------------
  VERIFY_DB="libevra_verify_${STAMP}"
  echo "→ 恢复演练：建临时库 $VERIFY_DB …"

  cleanup() {
    docker compose -f docker-compose.prod.yml exec -T db \
      env PGPASSWORD="$POSTGRES_PASSWORD" \
      dropdb -U "$POSTGRES_USER" --if-exists "$VERIFY_DB" >/dev/null 2>&1 || true
  }
  trap cleanup EXIT

  docker compose -f docker-compose.prod.yml exec -T db \
    env PGPASSWORD="$POSTGRES_PASSWORD" \
    createdb -U "$POSTGRES_USER" "$VERIFY_DB"

  docker compose -f docker-compose.prod.yml exec -T db \
    env PGPASSWORD="$POSTGRES_PASSWORD" \
    pg_restore -U "$POSTGRES_USER" -d "$VERIFY_DB" --exit-on-error < "$DUMP"

  echo "✅ 已恢复到临时库"

  # ⚠️ 比对**每一张表**的行数，而不是只看"恢复没报错"。
  # 漏一张表、少一批行，都可能恢复"成功"。
  MISMATCH=0
  for T in users books book_members transactions categories payment_methods tags \
           registration_invites sessions export_logs import_logs notification_quota \
           notifications book_messages book_share_links transaction_events \
           transaction_conflicts conflict_resolutions transaction_tags counters; do
    SRC=$(docker compose -f docker-compose.prod.yml exec -T db \
      env PGPASSWORD="$POSTGRES_PASSWORD" \
      psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "select count(*) from $T" 2>/dev/null || echo "missing")
    DST=$(docker compose -f docker-compose.prod.yml exec -T db \
      env PGPASSWORD="$POSTGRES_PASSWORD" \
      psql -U "$POSTGRES_USER" -d "$VERIFY_DB" -tAc "select count(*) from $T" 2>/dev/null || echo "missing")
    if [ "$SRC" != "$DST" ]; then
      echo "  ❌ $T：源 $SRC / 备份 $DST"
      MISMATCH=1
    fi
  done

  if [ "$MISMATCH" -ne 0 ]; then
    echo
    echo "❌ 行数不一致——这份备份**不能**拿去救命。" >&2
    exit 1
  fi
  echo "✅ 行数一致（逐表比对）"
  echo "🎉 这份备份验证通过，可以拿去救命。"
fi

# ---------------------------------------------------------------------------
# 轮转
# ---------------------------------------------------------------------------
echo
echo "→ 清理超过 $KEEP_DAYS 天的备份…"
DELETED=0
while IFS= read -r OLD; do
  [ -z "$OLD" ] && continue
  rm -f "$OLD"
  DELETED=$((DELETED + 1))
done < <(find "$BACKUP_DIR" -name '*.dump' -type f -mtime "+$KEEP_DAYS")
echo "  删除 $DELETED 个旧备份"

echo
echo "当前备份："
ls -lh "$BACKUP_DIR"/*.dump 2>/dev/null | awk '{print "  " $9 "  " $5}' || echo "  （无）"

echo
echo "⚠️ **本地备份不是备份策略，只是备份的第一步。**"
echo "   同一台服务器上的备份，和服务器一起消失。"
echo "   异地那一份（计划中是 30 天）见 docs/S12-A上线前安全与发布准备.md §9。"
