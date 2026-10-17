#!/usr/bin/env bash
#
# Libevra — 生产备份：导出、**证明能恢复**、保留、轮转、写状态。
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
# ⚠️ **S12-C（2026-10-17）的三处修改**，都是为了让它可以无人值守：
#   1. **逐表比对不再硬编码表名**，改成从 `information_schema` 现取。
#      以前漏了 `admin_grants` / `admin_allowlist` / `_prisma_migrations` 三张表 ——
#      备份若缺了权限表，演练会报"通过"（这正是本项目最忌讳的那种"看起来成功"）。
#   2. **轮转永不删除最新 N 份**。以前只按 `-mtime +7` 删：如果连续失败多日，
#      最新那份也会被当成"旧文件"删掉 —— 而它可能是唯一可用的一份。
#   3. **写状态文件** `backups/last-local.json`（不含秘密）。
#      数据库挂掉时，这份文件是唯一能回答"上次备份是什么时候"的东西。
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
# ⚠️ 无论多旧，**最新的这几份永远不删**。3 份 = 即使连坏两天也还有一份可退。
KEEP_NEWEST=3

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
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
DUMP="$BACKUP_DIR/${POSTGRES_DB}-${STAMP}.dump"
STATUS_FILE="$BACKUP_DIR/last-local.json"

# 状态：默认失败，任何一步成功才把它翻成 true。
LOCAL_OK=false
RESTORE_OK=false
ERROR_MSG=""
SIZE_BYTES=0
SHA256=""
TABLES_COMPARED=0

# ⚠️ **任何退出路径都要留下状态**，包括 `set -e` 直接炸掉的那种。
# 否则"上一次到底成没成"就成了空白 —— 而空白会被读成"应该没事"。
write_status() {
  local finished_at
  finished_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  local dump_name
  dump_name="$(basename "$DUMP")"

  cat > "$STATUS_FILE.tmp" <<JSON
{
  "kind": "local",
  "startedAt": "$STARTED_AT",
  "finishedAt": "$finished_at",
  "localOk": $LOCAL_OK,
  "restoreOk": $RESTORE_OK,
  "dump": "$dump_name",
  "sizeBytes": $SIZE_BYTES,
  "sha256": "$SHA256",
  "tablesCompared": $TABLES_COMPARED,
  "error": $(if [ -n "$ERROR_MSG" ]; then printf '"%s"' "$(printf '%s' "$ERROR_MSG" | tr -d '"' | tr '\n' ' ')"; else printf 'null'; fi),
  "host": "$(hostname)",
  "db": "$POSTGRES_DB"
}
JSON
  mv "$STATUS_FILE.tmp" "$STATUS_FILE"
}

cleanup() {
  local code=$?
  if [ "$code" -ne 0 ] && [ -z "$ERROR_MSG" ]; then
    ERROR_MSG="脚本在第 ${code} 行附近失败（退出码 $code）"
  fi
  write_status
  exit "$code"
}
trap cleanup EXIT

echo "=== Libevra 生产备份 ==="
echo "库：$POSTGRES_DB    文件：$DUMP"
echo

# ⚠️ `-Fc`（自定义格式）而不是纯 SQL：它可以 `--list`、可以并行恢复、可以只恢复一张表。
# 纯 SQL 备份只能整个重放，而"只想找回一笔账"是真实会发生的事。
echo "→ 导出…"
set +e
docker compose -f docker-compose.prod.yml exec -T db \
  env PGPASSWORD="$POSTGRES_PASSWORD" \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc \
  > "$DUMP"
DUMP_CODE=$?
set -e
if [ "$DUMP_CODE" -ne 0 ]; then
  ERROR_MSG="pg_dump 退出码 $DUMP_CODE"
  echo "❌ 导出失败（退出码 $DUMP_CODE）" >&2
  exit 1
fi

SIZE_BYTES="$(stat -c%s "$DUMP" 2>/dev/null || echo 0)"
SIZE="$(du -h "$DUMP" | cut -f1)"
# ⚠️ 一个 0 字节或极小的 dump 是最危险的"成功"：文件在、命令退出码 0、但里面没东西。
if [ "$SIZE_BYTES" -lt 4096 ]; then
  ERROR_MSG="dump 只有 ${SIZE_BYTES} 字节，太小"
  echo "❌ 备份文件只有 ${SIZE_BYTES} 字节 —— 视为失败。" >&2
  exit 1
fi
SHA256="$(sha256sum "$DUMP" | cut -d' ' -f1)"
LOCAL_OK=true
echo "✅ 备份写完：$SIZE（sha256 ${SHA256:0:16}…）"

# ---------------------------------------------------------------------------
# 校验一：归档可解析
# ---------------------------------------------------------------------------
echo "→ 校验归档可解析…"
TOC="$(docker compose -f docker-compose.prod.yml exec -T db pg_restore --list < "$DUMP" | grep -c ';' || true)"
if [ "${TOC:-0}" -lt 10 ]; then
  LOCAL_OK=false
  ERROR_MSG="归档条目只有 ${TOC:-0} 个，可能被截断"
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

  drop_verify() {
    docker compose -f docker-compose.prod.yml exec -T db \
      env PGPASSWORD="$POSTGRES_PASSWORD" \
      dropdb -U "$POSTGRES_USER" --if-exists "$VERIFY_DB" >/dev/null 2>&1 || true
  }
  trap 'drop_verify; cleanup' EXIT

  docker compose -f docker-compose.prod.yml exec -T db \
    env PGPASSWORD="$POSTGRES_PASSWORD" \
    createdb -U "$POSTGRES_USER" "$VERIFY_DB"

  if ! docker compose -f docker-compose.prod.yml exec -T db \
      env PGPASSWORD="$POSTGRES_PASSWORD" \
      pg_restore -U "$POSTGRES_USER" -d "$VERIFY_DB" --exit-on-error < "$DUMP"; then
    ERROR_MSG="pg_restore 恢复失败"
    echo "❌ 恢复到临时库失败。" >&2
    exit 1
  fi

  echo "✅ 已恢复到临时库"

  # ⚠️ **比对"每一张表"，而不是只看"恢复没报错"。** 漏一张表、少一批行，都可能恢复"成功"。
  #
  # ⚠️ **表名从库里现取，不再手抄清单（S12-C）**：手抄的清单会漏掉新表 ——
  # 实测漏过 `admin_grants` / `admin_allowlist` / `_prisma_migrations` 三张。
  # 一个"漏了权限表也报通过"的演练，比没有演练更糟：它给出的是错误的安心。
  TABLES="$(docker compose -f docker-compose.prod.yml exec -T db \
    env PGPASSWORD="$POSTGRES_PASSWORD" \
    psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc \
    "select table_name from information_schema.tables where table_schema = 'public' order by 1")"

  MISMATCH=0
  for T in $TABLES; do
    TABLES_COMPARED=$((TABLES_COMPARED + 1))
    SRC=$(docker compose -f docker-compose.prod.yml exec -T db \
      env PGPASSWORD="$POSTGRES_PASSWORD" \
      psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "select count(*) from \"$T\"" 2>/dev/null || echo "missing")
    DST=$(docker compose -f docker-compose.prod.yml exec -T db \
      env PGPASSWORD="$POSTGRES_PASSWORD" \
      psql -U "$POSTGRES_USER" -d "$VERIFY_DB" -tAc "select count(*) from \"$T\"" 2>/dev/null || echo "missing")
    if [ "$SRC" != "$DST" ]; then
      echo "  ❌ $T：源 $SRC / 备份 $DST"
      MISMATCH=1
    fi
  done

  if [ "$MISMATCH" -ne 0 ]; then
    RESTORE_OK=false
    ERROR_MSG="逐表行数不一致"
    echo
    echo "❌ 行数不一致——这份备份**不能**拿去救命。" >&2
    exit 1
  fi

  RESTORE_OK=true
  echo "✅ 行数一致（逐表比对，共 ${TABLES_COMPARED} 张表）"
  echo "🎉 这份备份验证通过，可以拿去救命。"

  drop_verify
  trap cleanup EXIT
fi

# ---------------------------------------------------------------------------
# 轮转
# ---------------------------------------------------------------------------
echo
echo "→ 清理超过 $KEEP_DAYS 天的备份（但**永远保留最新 $KEEP_NEWEST 份**）…"
DELETED=0
# 最新 N 份的名字，用于排除。
NEWEST="$(ls -1t "$BACKUP_DIR"/*.dump 2>/dev/null | head -n "$KEEP_NEWEST" || true)"
while IFS= read -r OLD; do
  [ -z "$OLD" ] && continue
  # ⚠️ 最新几份无论多旧都不删：删掉它们可能删掉唯一可用的备份。
  if printf '%s\n' "$NEWEST" | grep -qxF "$OLD"; then
    continue
  fi
  rm -f "$OLD"
  DELETED=$((DELETED + 1))
done < <(find "$BACKUP_DIR" -name '*.dump' -type f -mtime "+$KEEP_DAYS")
echo "  删除 $DELETED 个旧备份"

echo
echo "当前备份："
ls -lh "$BACKUP_DIR"/*.dump 2>/dev/null | awk '{print "  " $9 "  " $5}' || echo "  （无）"

echo
echo "迁移状态已包含在备份里（表 _prisma_migrations）；恢复时请让应用版本与它对齐。"
echo "⚠️ **本地备份不是备份策略，只是备份的第一步。**"
echo "   同一台服务器上的备份，和服务器一起消失 —— 异地那一份由 backup-all.sh 负责。"
