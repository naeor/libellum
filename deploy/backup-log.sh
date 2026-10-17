#!/usr/bin/env bash
#
# Libevra — 把一次备份的结论写进 `backup_logs`（管理台"备份状态"的唯一数据来源）。
#
# ⚠️ **best-effort：这个脚本永远退出 0。**
#   "备份状态写不进去"不等于"备份失败"——数据库不可用时，备份本身通常已经失败，
#   外部心跳与邮件告警负责报告；这里失败只会在 stderr 留一行警告，**绝不改变调用方的退出码**。
#   理由见 `S13-D-上线准备报告.md` §5.3。
#
# ⚠️ **只有 `backup-all.sh` 的全流程成功后才写 `ok=true`**：
#   本地导出 + 隔离恢复演练 + 加密 + COS 上传 + 远端元数据校验全部通过。
#   `backup.sh` 单独跑（只做本地备份）**不写成功**——那只是备份的第一步。
#
# ⚠️ **"备份成功"与"心跳送达"是两件事**：本脚本不读心跳结果；
#   心跳失败不会让这里变成失败，备份成功也不会让 Healthchecks 收到信号。
#
# 用法：
#   ./backup-log.sh --ok   --started-at "$STARTED_AT" --file-ref "$DUMP" \
#       --note "local+restore+encrypt+upload+remote-meta ok"
#   ./backup-log.sh --fail --started-at "$STARTED_AT" --stage upload \
#       --note "上传 COS 失败" [--file-ref "$DUMP"]
#
# ⚠️ **不传数据库口令**：psql 走数据库容器的本地 socket（镜像默认 trust），
#   与运维手册里的只读查询同一条通道；`.env` 只用来取 `POSTGRES_USER` / `POSTGRES_DB`
#   两个非秘密值。**输出里不打印 SQL、不打印环境变量、不打印容器命令参数。**
#
# ⚠️ **表还不存在时（S13 尚未部署）**：写入失败、打印一行警告、仍然退出 0。
#   旧版定时任务继续工作，现有生产备份不受影响。
#
# ⚠️ **不要在 `set -x` 下运行**：本项目已记录过一次 `bash -x` 把 `source` 的密钥打进日志的事故
#   （`教训.md` §8.14）。

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

MODE=""
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
FILE_REF=""
NOTE=""
STAGE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --ok)        MODE="ok" ;;
    --fail)      MODE="fail" ;;
    --stage)     STAGE="${2:-}"; shift ;;
    --started-at) STARTED_AT="${2:-}"; shift ;;
    --file-ref)  FILE_REF="${2:-}"; shift ;;
    --note)      NOTE="${2:-}"; shift ;;
    *) echo "未知参数：$1" >&2; exit 0 ;;
  esac
  shift
done

if [ "$MODE" = "" ]; then
  echo "⚠️ backup-log.sh 需要 --ok 或 --fail；本次不写状态。" >&2
  exit 0
fi

# ---------------------------------------------------------------------------
# 非秘密配置：只取 POSTGRES_USER / POSTGRES_DB。
# ⚠️ 用 `set -a` + source 与 backup.sh 保持一致；这里不读、不打印口令。
# ---------------------------------------------------------------------------
if [ -f .env ]; then
  # shellcheck disable=SC1091
  set -a; . ./.env; set +a
fi

if [ -z "${POSTGRES_USER:-}" ] || [ -z "${POSTGRES_DB:-}" ]; then
  echo "⚠️ deploy/.env 缺少 POSTGRES_USER/POSTGRES_DB，跳过备份状态写入（不影响备份结论）。" >&2
  exit 0
fi

# ---------------------------------------------------------------------------
# 参数清洗（**不参与日志输出**）：
#   · note 限 480 字符（列宽 500，留余量）；
#   · 换行/制表符压成空格，避免 psql 变量里出现控制字符；
#   · file_ref 只保留文件名，绝不写入宿主机绝对路径。
# ---------------------------------------------------------------------------
NOTE="$(printf '%s' "$NOTE" | tr '\n\r\t' '   ' | cut -c1-480)"
FILE_REF="$(basename -- "${FILE_REF:-}" 2>/dev/null || true)"
if [ "$MODE" = "ok" ]; then
  OK_VALUE="true"
  if [ -z "$NOTE" ]; then NOTE="full backup chain ok"; fi
else
  OK_VALUE="false"
  if [ -z "$NOTE" ]; then NOTE="backup failed"; fi
  if [ -n "$STAGE" ]; then
    NOTE="[$STAGE] $NOTE"
  fi
  NOTE="$(printf '%s' "$NOTE" | cut -c1-480)"
fi

# psql 变量绑定（`:'name'`）而不是字符串拼接：值里带引号也不会变成 SQL。
SQL="insert into backup_logs (id, started_at, finished_at, ok, file_ref, note)
     values (gen_random_uuid(), :'started_at'::timestamptz, now(), :'ok'::boolean,
             nullif(:'file_ref',''), nullif(:'note',''));"

ERR_LOG="$(mktemp)"
cleanup() { rm -f "$ERR_LOG"; }
trap cleanup EXIT

# ⚠️ **SQL 通过 stdin + `-f -` 传入，不用 `-c`。**
#   `psql -c` 不会做变量插值（实测：`:'started_at'` 会被服务器当成语法错误），
#   而 stdin 的脚本会经过 psql 自己的解析器，`:'name'` 才是安全的参数绑定。
#   `docker compose exec -T` 的 stdin 本来就是给容器内命令用的（backup.sh 也用它灌 dump）。
PSQL_CMD=(
  docker compose -f docker-compose.prod.yml exec -T db
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"
  -v ON_ERROR_STOP=1 -q
  -v "started_at=$STARTED_AT"
  -v "ok=$OK_VALUE"
  -v "file_ref=$FILE_REF"
  -v "note=$NOTE"
  -f -
)

# ⚠️ 超时是防线：数据库不可用或容器挂起时，**不能让备份流程等着写一条状态**。
#   20 秒远大于正常写入，又远小于一次备份本身。
if command -v timeout >/dev/null 2>&1; then
  if printf '%s\n' "$SQL" | timeout 20s "${PSQL_CMD[@]}" 2>"$ERR_LOG"; then
    exit 0
  fi
else
  if printf '%s\n' "$SQL" | "${PSQL_CMD[@]}" 2>"$ERR_LOG"; then
    exit 0
  fi
fi

# ---------------------------------------------------------------------------
# 失败只报告，不改变调用方结论。**不输出 ERR_LOG 全文**，只做两类可行动提示：
#   · 表不存在 → S13 迁移尚未部署；
#   · 其他 → 数据库暂时不可用/写入失败。
# ---------------------------------------------------------------------------
if grep -q 'relation "backup_logs" does not exist' "$ERR_LOG" 2>/dev/null; then
  echo "⚠️ backup_logs 表尚不存在（S13 迁移未部署），本次备份状态未写入；备份本身不受影响。" >&2
else
  echo "⚠️ 备份状态写入失败（不影响备份结论）；可在服务器上手工检查 backup_logs。" >&2
fi

exit 0
