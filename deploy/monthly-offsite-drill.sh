#!/usr/bin/env bash
#
# Libevra — **月度异地演练**：公开 COS 上那一份**真的能取回、能解密、能恢复**。
#
# ⚠️ **为什么要单独一个月度流程**：日常上传身份**没有读权限**（有意如此），
# 所以它只能验证"对象存在且大小对"。而"能下载、能解密、能恢复"只能由
# **恢复身份**来证明 —— 恢复身份**不常驻生产服务器**，所以这个脚本在**你的电脑
# 或一台临时机器**上跑，不在生产服务器上跑。
#
# 流程：列云端 → 取回最近一份 → 解密 → **隔离临时库恢复** → 逐表行数对照 → 报告
#
# 用法（在你自己的机器上，能 SSH/连到一套 PostgreSQL 的隔离环境）：
#   ./monthly-offsite-drill.sh
#   ./monthly-offsite-drill.sh --ref daily/2026/10/xxx.dump.gpg
#
# 需要：
#   · 恢复身份：COS_RESTORE_ID / COS_RESTORE_KEY（环境变量或 .backup-restore.env）
#   · 加密口令：.backup.key（你的敏感信息目录里那一份）
#   · 一个**隔离的** PostgreSQL（绝不能指向生产）
#
# ⚠️ 验证用的是 `verify-dump.sh` —— 它只建自己的临时库，**不会 drop 任何已有库**。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

REF=""
OUT_DIR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF="${2:?--ref needs a value}"; shift ;;
    --out) OUT_DIR="${2:?--out needs a value}"; shift ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
  shift
done

echo "=== Libevra 月度异地演练 $(date '+%Y-%m-%d %H:%M:%S %Z') ==="
echo

# ⚠️ 防呆：如果当前目录下有生产 .env 且库名像生产库，**直接拒绝**。
# "演练"覆盖生产库是这份设计里最不能发生的事。
if [ -f .env ]; then
  # shellcheck disable=SC1091
  set -a; . ./.env; set +a
  if [ "${POSTGRES_DB:-}" = "libevra_prod" ]; then
    echo "❌ 当前目录的 deploy/.env 指向 **libevra_prod**（生产库）。" >&2
    echo "   月度演练必须在隔离环境执行（例如临时机器 / 临时 compose 项目）。" >&2
    exit 1
  fi
fi

ARGS=(--latest)
[ -n "$REF" ] && ARGS=(--ref "$REF")
[ -n "$OUT_DIR" ] && ARGS+=(--out "$OUT_DIR")

if ! ./offsite-fetch.sh "${ARGS[@]}"; then
  echo "❌ 取回或解密失败 —— **异地那份可能不可用**。这是需要立刻处理的信号。" >&2
  exit 1
fi

# offsite-fetch 把文件放在 backups/restored/ 下；找最新的 .dump
DUMP="$(ls -1t backups/restored/*.dump 2>/dev/null | head -1 || true)"
if [ -z "$DUMP" ]; then
  echo "❌ 没有找到解密后的 dump。" >&2
  exit 1
fi

echo
./verify-dump.sh "$DUMP" --expect backups/last-local.json

echo
echo "🎉 月度异地演练通过：COS 上的备份**可以真的救回数据**。"
echo "   ⚠️ 请把这个结果记一笔（日期 + 文件名），并在管理后台把"
echo "      \"异地内容验证\" 视为已完成（S13 后台尚未接这个字段，先记在状态文件里）。"
