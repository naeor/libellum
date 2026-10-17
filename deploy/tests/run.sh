#!/usr/bin/env bash
#
# Libevra — 备份脚本的**自动测试**（bash 实现，CI 在 ubuntu-latest 上跑）。
#
# ⚠️ 这些测试**不连数据库、不连网络**：
#   · `curl` 被替换成一个记录调用并返回预设响应的假实现；
#   · 只测试"决策逻辑"——什么时候发邮件、什么时候不发、心跳发到哪个 URL、
#     危险操作会不会被拒绝。
#
# 之所以测这些：**告警系统最容易错的地方不是"发不出信"，而是"该发的时候不发"
# 或"不该发的时候刷屏"**，而这两类错误在真实故障前都不会暴露。
#
# 运行：bash deploy/tests/run.sh

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEPLOY="$ROOT/deploy"
WORK="$(mktemp -d)"
PASS=0
FAIL=0

cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

ok()   { PASS=$((PASS + 1)); echo "  ✅ $1"; }
bad()  { FAIL=$((FAIL + 1)); echo "  ❌ $1"; [ -n "${2:-}" ] && echo "     $2"; }

# ---------------------------------------------------------------------------
# 假 curl：把请求记录下来，按 MOCK_HTTP / MOCK_BODY 返回
# ---------------------------------------------------------------------------
mkdir -p "$WORK/bin"
cat > "$WORK/bin/curl" <<'SH'
#!/usr/bin/env bash
# 记录完整调用（含 URL 和 --data-binary 文件内容摘要）
echo "ARGS: $*" >> "$MOCK_LOG"
OUT=""
URL=""
prev=""
for a in "$@"; do
  case "$prev" in
    -o) OUT="$a" ;;
  esac
  case "$a" in
    http*) URL="$a" ;;
  esac
  prev="$a"
done
echo "URL: $URL" >> "$MOCK_LOG"
[ -n "$OUT" ] && printf '%s' "${MOCK_BODY:-{\"id\":\"mock-id\"}}" > "$OUT"
printf '%s' "${MOCK_HTTP:-200}"
exit 0
SH
chmod +x "$WORK/bin/curl"

# ---------------------------------------------------------------------------
# 假 docker：记录调用；MOCK_DOCKER_EXIT / MOCK_DOCKER_STDERR 用于模拟
# "表不存在 / 数据库不可用"。**不执行任何真实容器命令。**
# ---------------------------------------------------------------------------
cat > "$WORK/bin/docker" <<'SH'
#!/usr/bin/env bash
{
  echo "DOCKER: $*"
  # backup-log.sh 通过 stdin 把 SQL 交给 psql（`-f -`）；记下来，
  # 测试才能验证"真的发起了插入"，而不是只看它退出 0。
  if [ ! -t 0 ]; then
    echo "STDIN:"
    cat
  fi
} >> "$DOCKER_LOG"
[ -n "${MOCK_DOCKER_STDERR:-}" ] && printf '%s\n' "$MOCK_DOCKER_STDERR" >&2
exit "${MOCK_DOCKER_EXIT:-0}"
SH
chmod +x "$WORK/bin/docker"

export PATH="$WORK/bin:$PATH"
export MOCK_LOG="$WORK/curl.log"
export DOCKER_LOG="$WORK/docker.log"

run_with_mocks() { : > "$MOCK_LOG"; }

# ---------------------------------------------------------------------------
echo "=== 1. 所有脚本语法检查 ==="
for f in "$DEPLOY"/*.sh "$DEPLOY"/tests/run.sh; do
  if bash -n "$f" 2>/dev/null; then ok "bash -n $(basename "$f")"; else bad "bash -n $(basename "$f")"; fi
done

# ---------------------------------------------------------------------------
echo
echo "=== 2. 告警邮件：未配置时必须明确说"未启用"（退出码 3） ==="
ALERT_DIR="$WORK/alert"
mkdir -p "$ALERT_DIR/backups"
cp "$DEPLOY/alert-mail.sh" "$ALERT_DIR/"
if (cd "$ALERT_DIR" && ./alert-mail.sh --test >/dev/null 2>&1); then
  bad "未配置时应该退出 3，实际是 0"
else
  CODE=$?
  [ "$CODE" -eq 3 ] && ok "未配置 → 退出码 3（明确未启用）" || bad "未配置 → 退出码 $CODE，期望 3"
fi

# ---------------------------------------------------------------------------
echo
echo "=== 3. 告警去重与恢复通知 ==="
cp "$DEPLOY/alert-mail.sh" "$ALERT_DIR/"
cat > "$ALERT_DIR/.backup-mail.env" <<'ENV'
MAIL_API_KEY=test-key
MAIL_TO=test@example.com
MAIL_FROM="Libevra 备份 <backup@libevra.com>"
ENV

send_count() {
  local n
  n="$(grep -c 'URL: https://api.resend.com/emails' "$MOCK_LOG" 2>/dev/null || true)"
  echo "${n:-0}"
}

# 3a 首次失败 → 发
run_with_mocks
(cd "$ALERT_DIR" && ./alert-mail.sh --stage local --error "disk full" --last-success "2026-10-16" >/dev/null 2>&1)
[ "$(send_count)" -ge 1 ] && ok "首次失败 → 发邮件" || bad "首次失败没发邮件" "$(cat "$MOCK_LOG")"

# 3b 同一阶段立刻再失败 → 不发
run_with_mocks
(cd "$ALERT_DIR" && ./alert-mail.sh --stage local --error "disk full" >/dev/null 2>&1)
[ "$(send_count)" -eq 0 ] && ok "同一故障再次失败 → 24 小时内不重复" || bad "同一故障重复发送"

# 3c 阶段变化 → 立即发
run_with_mocks
(cd "$ALERT_DIR" && ./alert-mail.sh --stage upload --error "COS 403" >/dev/null 2>&1)
[ "$(send_count)" -ge 1 ] && ok "失败阶段变化 → 立即发" || bad "阶段变化没发"

# 3d 恢复 → 发一次恢复通知
run_with_mocks
(cd "$ALERT_DIR" && ./alert-mail.sh --recovered >/dev/null 2>&1)
[ "$(send_count)" -ge 1 ] && ok "恢复 → 发恢复通知" || bad "恢复通知没发"

# 3e 再恢复一次 → 不发（避免每天一封"正常"）
run_with_mocks
(cd "$ALERT_DIR" && ./alert-mail.sh --recovered >/dev/null 2>&1)
[ "$(send_count)" -eq 0 ] && ok "持续正常 → 不发恢复通知" || bad "正常状态重复发恢复通知"

# 3f API 5xx → 退出码非零（不能把发送失败当成功）
run_with_mocks
export MOCK_HTTP=500
(cd "$ALERT_DIR" && ./alert-mail.sh --stage encrypt --error "boom" >/dev/null 2>&1)
CODE=$?
[ "$CODE" -ne 0 ] && ok "邮件 API 失败 → 退出码非零" || bad "邮件 API 失败却返回 0"
unset MOCK_HTTP

# 3g 状态里不能出现密钥
if grep -q 'test-key' "$ALERT_DIR/backups/alert-state.json" 2>/dev/null; then
  bad "alert-state.json 里含有 API key"
else
  ok "状态文件不含 API key"
fi

# ---------------------------------------------------------------------------
echo
echo "=== 4. 心跳：未配置 / 成功 / 失败路径 ==="
HB_DIR="$WORK/hb"
mkdir -p "$HB_DIR/backups"
cp "$DEPLOY/heartbeat.sh" "$HB_DIR/"

if (cd "$HB_DIR" && ./heartbeat.sh --ok >/dev/null 2>&1); then
  bad "未配置心跳应退出 3"
else
  [ $? -eq 3 ] && ok "心跳未配置 → 退出码 3" || bad "心跳未配置退出码不对"
fi

cat > "$HB_DIR/.backup-heartbeat.env" <<'ENV'
HEARTBEAT_URL=https://hc-ping.com/00000000-0000-0000-0000-000000000000
ENV

run_with_mocks
(cd "$HB_DIR" && ./heartbeat.sh --ok >/dev/null 2>&1)
grep -q 'URL: https://hc-ping.com/00000000-0000-0000-0000-000000000000$' "$MOCK_LOG" \
  && ok "成功心跳打到基础 URL" || bad "成功心跳 URL 不对" "$(cat "$MOCK_LOG")"

run_with_mocks
(cd "$HB_DIR" && ./heartbeat.sh --fail "上传失败" >/dev/null 2>&1)
grep -q '/fail$' "$MOCK_LOG" && ok "失败心跳打到 /fail" || bad "失败心跳 URL 不对" "$(cat "$MOCK_LOG")"

run_with_mocks
export MOCK_HTTP=500
if (cd "$HB_DIR" && ./heartbeat.sh --ok >/dev/null 2>&1); then
  bad "心跳 5xx 应返回非零"
else
  ok "心跳 5xx → 退出码非零（监控失效会被发现）"
fi
unset MOCK_HTTP

# ---------------------------------------------------------------------------
echo
echo "=== 5. 危险操作的防呆 ==="
DRILL_DIR="$WORK/drill"
mkdir -p "$DRILL_DIR"
cp "$DEPLOY/monthly-offsite-drill.sh" "$DEPLOY/offsite-fetch.sh" "$DRILL_DIR/"
printf 'POSTGRES_USER=x\nPOSTGRES_PASSWORD=x\nPOSTGRES_DB=libevra_prod\n' > "$DRILL_DIR/.env"
if (cd "$DRILL_DIR" && ./monthly-offsite-drill.sh >/dev/null 2>&1); then
  bad "月度演练面对生产库应拒绝"
else
  ok "月度演练面对 libevra_prod → 拒绝执行"
fi

# offsite-fetch：恢复身份与上传身份相同时必须拒绝
FETCH_DIR="$WORK/fetch"
mkdir -p "$FETCH_DIR"
cp "$DEPLOY/offsite-fetch.sh" "$FETCH_DIR/"
touch "$FETCH_DIR/.backup.key"
if (cd "$FETCH_DIR" && COS_UPLOAD_ID=same COS_RESTORE_ID=same COS_RESTORE_KEY=k COS_BUCKET=b ./offsite-fetch.sh --list >/dev/null 2>&1); then
  bad "恢复身份=上传身份时应拒绝"
else
  ok "恢复身份与上传身份相同 → 拒绝（最小权限设计）"
fi

# ---------------------------------------------------------------------------
echo
echo "=== 6. 状态文件结构（schemaVersion 2 的三态分离） ==="
if grep -q 'remoteMetaOk' "$DEPLOY/backup-all.sh" \
   && grep -q '"contentVerified": false' "$DEPLOY/backup-all.sh" \
   && grep -q 'schemaVersion' "$DEPLOY/backup-all.sh"; then
  ok "backup-all.sh 记录了 local/encrypt/offsite(上传+元数据)/heartbeat/notify 且区分 contentVerified"
else
  bad "backup-all.sh 状态字段不完整"
fi
if grep -q 'tableCounts' "$DEPLOY/backup.sh"; then
  ok "backup.sh 记录 tableCounts（异地演练的对照物）"
else
  bad "backup.sh 没有记录 tableCounts"
fi

# ---------------------------------------------------------------------------
echo
echo "=== 7. backup_logs 写入：best-effort，绝不改变备份退出码 ==="
LOG_DIR="$WORK/backuplog"
mkdir -p "$LOG_DIR/backups"
cp "$DEPLOY/backup-log.sh" "$LOG_DIR/"
chmod +x "$LOG_DIR/backup-log.sh"
cat > "$LOG_DIR/.env" <<'ENV'
POSTGRES_USER=libevra
POSTGRES_DB=libevra_prod
POSTGRES_PASSWORD=super-secret-value
ENV

run_docker_mocks() { : > "$DOCKER_LOG"; }

# 7a 成功路径：退出 0，确实调用了一次向 backup_logs 的插入
run_docker_mocks
OUT="$( (cd "$LOG_DIR" && ./backup-log.sh --ok --started-at 2026-10-17T19:00:00Z \
  --file-ref libevra_prod-test.dump --note "local+restore+encrypt+upload+remote-meta ok") 2>&1 )"
CODE=$?
[ "$CODE" -eq 0 ] && ok "写入成功路径 → 退出 0" || bad "写入成功路径退出码 $CODE" "$OUT"
grep -q 'insert into backup_logs' "$DOCKER_LOG" && ok "命令确实发起了 backup_logs 插入" || bad "没有发起插入" "$(cat "$DOCKER_LOG")"
grep -q "libevra_prod-test.dump" "$DOCKER_LOG" && ok "file_ref 只写文件名" || bad "file_ref 未传给 psql"

# 7b 表不存在（S13 迁移未部署）：退出 0，并给出可行动提示
run_docker_mocks
OUT="$( (cd "$LOG_DIR" && MOCK_DOCKER_EXIT=1 \
  MOCK_DOCKER_STDERR='ERROR: relation "backup_logs" does not exist' \
  ./backup-log.sh --ok --started-at 2026-10-17T19:00:00Z --note ok) 2>&1 )"
CODE=$?
[ "$CODE" -eq 0 ] && ok "表不存在 → 仍退出 0（不改变备份结论）" || bad "表不存在时退出码 $CODE"
printf '%s' "$OUT" | grep -q 'S13 迁移未部署' && ok "表不存在 → 提示可行动原因" || bad "表不存在时没有提示" "$OUT"

# 7c 数据库不可用：退出 0，且不打印任何凭据
run_docker_mocks
OUT="$( (cd "$LOG_DIR" && MOCK_DOCKER_EXIT=1 \
  MOCK_DOCKER_STDERR='psql: error: connection to server failed' \
  ./backup-log.sh --fail --stage upload --note "上传 COS 失败" --started-at 2026-10-17T19:00:00Z) 2>&1 )"
CODE=$?
[ "$CODE" -eq 0 ] && ok "数据库不可用 → 仍退出 0" || bad "数据库不可用时退出码 $CODE"
printf '%s' "$OUT" | grep -q 'super-secret-value' && bad "输出泄露了口令" || ok "输出不含口令"

# 7d 未配置数据库变量：安静跳过
NOENV_DIR="$WORK/backuplog-noenv"
mkdir -p "$NOENV_DIR"
cp "$DEPLOY/backup-log.sh" "$NOENV_DIR/"
chmod +x "$NOENV_DIR/backup-log.sh"
run_docker_mocks
OUT="$( (cd "$NOENV_DIR" && ./backup-log.sh --ok --note ok) 2>&1 )"
CODE=$?
[ "$CODE" -eq 0 ] && ok "未配置 .env → 退出 0（静默跳过）" || bad "未配置时退出码 $CODE"
[ -s "$DOCKER_LOG" ] && bad "未配置时仍调用了 docker" || ok "未配置时没有调用 docker"

# 7e backup-all.sh 的接线与顺序：成功状态必须在心跳**之前**写，
#    且意外退出/失败路径也要写；helper 通过 bash 调用，不依赖可执行位。
grep -q 'bash "$SCRIPT_DIR/backup-log.sh"' "$DEPLOY/backup-all.sh" \
  && ok "backup-all.sh 通过 bash 调用 helper（不依赖 chmod +x）" || bad "helper 调用方式不对"
grep -q 'log_backup_result --fail' "$DEPLOY/backup-all.sh" \
  && ok "失败路径写失败状态" || bad "失败路径没有写状态"
grep -q 'log_backup_result --ok' "$DEPLOY/backup-all.sh" \
  && ok "成功路径写成功状态" || bad "成功路径没有写状态"
OK_LINE="$(grep -n 'log_backup_result --ok' "$DEPLOY/backup-all.sh" | head -1 | cut -d: -f1)"
HB_LINE="$(grep -n '^ping_heartbeat ok' "$DEPLOY/backup-all.sh" | tail -1 | cut -d: -f1)"
if [ -n "$OK_LINE" ] && [ -n "$HB_LINE" ] && [ "$OK_LINE" -lt "$HB_LINE" ]; then
  ok "成功状态写在心跳之前（两者不混同）"
else
  bad "成功状态与心跳的顺序不对" "ok_line=$OK_LINE heartbeat_line=$HB_LINE"
fi

# ---------------------------------------------------------------------------
echo
echo "================================"
echo "  通过 $PASS 项，失败 $FAIL 项"
echo "================================"
[ "$FAIL" -eq 0 ] || exit 1
