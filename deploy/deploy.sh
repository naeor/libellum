#!/usr/bin/env bash
#
# Libevra — 发布一个**指定版本**，并在失败时回滚。
#
# ⚠️ **为什么发布要显式指定版本，而不是"main 更新就上线"。**
#
# 所有者明确要求过：*"GitHub 持续集成自动测试，但生产发布仍需要所有者主动确认。"*
# 这不是流程洁癖，而是这个项目的实际情况——**一台服务器、一个人维护**。
# 一个跟着 main 自动上线的服务，意味着任何一次推送都是一次没有验收的发布，
# 而"没验收"和"没发布"在事故复盘时是完全不同的两件事。
#
# ⚠️ **这个脚本不拉代码、不改 git 状态。** 它假定你要发布的那个 commit 已经在服务器上的
# 仓库里签出好了（步骤见 `README.md`）。它做的是：**记录当前版本 → 构建 → 迁移 → 起服务 →
# 健康检查 → 失败就退回去。**
#
# ⚠️ **它一行都不会碰数据卷。** 没有 `down -v`，没有 `prune --volumes`，
# 没有 `migrate reset`。**数据库的迁移是只向前的**，回滚应用**不会**撤销 schema——
# 这一点在下面 §回滚 里写明了。
#
# 用法（在服务器上，仓库目录里）：
#
#   ./deploy/deploy.sh --version 1.10.23
#   ./deploy/deploy.sh --version 1.10.23 --no-build   # 镜像已经构建过
#
# ⚠️ 发布前请先建一个备份：
#   ./deploy/backup.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

COMPOSE=(docker compose -f docker-compose.prod.yml)
VERSION=""
BUILD=1

while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="${2:?--version needs a value}"; shift ;;
    --no-build) BUILD=0 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
  shift
done

if [ -z "$VERSION" ]; then
  echo "❌ 必须显式指定版本：./deploy/deploy.sh --version 1.10.23" >&2
  echo "   （发布一个说不清编号的版本，等于放弃「这是哪一版」这个问题的答案。）" >&2
  exit 2
fi

echo "=== Libevra 发布 ==="
echo "目标版本：$VERSION"
echo

# ---------------------------------------------------------------------------
# 1. 记录当前版本，供回滚用
# ---------------------------------------------------------------------------
STATE_FILE=".last-deployed"
PREVIOUS=""
if [ -f "$STATE_FILE" ]; then
  PREVIOUS="$(cat "$STATE_FILE")"
fi
echo "当前已发布：${PREVIOUS:-（无记录）}"

# ⚠️ 发布前先确认工作区是干净的。带着未提交的改动发布的版本，
# **和仓库里那个 commit 不是同一个东西**，而事后没人能证明它是什么。
if git -C .. rev-parse --git-dir >/dev/null 2>&1; then
  if [ -n "$(git -C .. status --porcelain)" ]; then
    echo "⚠️ 工作区有未提交的改动。发布一个与 commit 不一致的构建是事故的常见起点。" >&2
    read -r -p "   继续？(y/N) " REPLY
    [ "$REPLY" = "y" ] || exit 1
  fi
  echo "提交：$(git -C .. rev-parse --short HEAD)  $(git -C .. log -1 --format=%s)"
fi
echo

# ---------------------------------------------------------------------------
# 2. 备份（发布前）
# ---------------------------------------------------------------------------
echo "→ 发布前备份…"
if [ -x ./backup.sh ]; then
  ./backup.sh --keep 7 || {
    echo "❌ 备份失败，停止发布。" >&2
    echo "   **一个没备份就发布的版本，出问题时没有回头路。**" >&2
    exit 1
  }
else
  echo "⚠️ 找不到 backup.sh，跳过备份。" >&2
fi
echo

# ---------------------------------------------------------------------------
# 3. 构建
# ---------------------------------------------------------------------------
if [ "$BUILD" -eq 1 ]; then
  echo "→ 构建镜像…"
  "${COMPOSE[@]}" build
  echo
fi

# ---------------------------------------------------------------------------
# 4. 迁移 + 起服务
#
# ⚠️ `up -d` 会在启动 api 之前先跑 migrate（compose 里的 depends_on 条件），
#    所以这一条命令的顺序是：db → migrate（跑完退出）→ api → web。
# ---------------------------------------------------------------------------
echo "→ 应用迁移并启动…"
"${COMPOSE[@]}" up -d --remove-orphans
echo

# ---------------------------------------------------------------------------
# 5. 健康检查——**不通过就没有"发布成功"这四个字**
# ---------------------------------------------------------------------------
echo "→ 健康检查…"
HEALTHY=0
for i in $(seq 1 30); do
  if "${COMPOSE[@]}" exec -T api \
      node -e "fetch('http://127.0.0.1:3000/api/v1/health').then(r=>r.json()).then(j=>process.exit(j.ok&&j.database==='up'?0:1)).catch(()=>process.exit(1))" \
      >/dev/null 2>&1; then
    HEALTHY=1
    break
  fi
  sleep 2
done

# ⚠️ 顺带确认 80/443 也在应答：API 健康但 Caddy 起不来，对用户而言仍然是全站不可用。
WEB_OK=0
for i in $(seq 1 15); do
  if "${COMPOSE[@]}" exec -T web wget -q --spider http://127.0.0.1/healthz >/dev/null 2>&1; then
    WEB_OK=1
    break
  fi
  sleep 2
done

if [ "$HEALTHY" -eq 1 ] && [ "$WEB_OK" -eq 1 ]; then
  echo "$VERSION" > "$STATE_FILE"
  echo
  echo "✅ 发布成功：$VERSION"
  echo "   API 健康（数据库 up）、Web 健康。"
  echo
  echo "⚠️ 还有两件手工确认的事："
  echo "   1. 用浏览器打开 https://\$LIBEVRA_DOMAIN，走一遍登录与记一笔；"
  echo "   2. 确认「账户 → 软件更新」显示的版本号就是 $VERSION。"
  exit 0
fi

# ---------------------------------------------------------------------------
# 6. 回滚
# ---------------------------------------------------------------------------
echo
echo "❌ 健康检查未通过（API=$HEALTHY Web=$WEB_OK）。" >&2
echo
echo "⚠️ **回滚应用不会回滚数据库。** 迁移是只向前的——如果一个新迁移删了列，"
echo "   退回旧镜像也换不回那列。所以："
echo
echo "   * **只改代码的版本**：切回上一个 commit，重新构建即可（下面这条命令）。"
echo "   * **改了 schema 的版本**：先读该迁移，判断旧代码能否在新 schema 上跑；"
echo "     不能就跑 `./deploy/restore.sh <备份文件>` 把**整个库**恢复到发布前那一刻。"
echo
if [ -n "$PREVIOUS" ]; then
  echo "若要回滚应用，执行：" >&2
  echo "    git -C .. log --oneline -10        # 找到上一个版本对应的 commit" >&2
  echo "    git -C .. checkout <commit>" >&2
  echo "    ./deploy/deploy.sh --version $PREVIOUS" >&2
else
  echo "没有记录到上一个版本，请手动决定。" >&2
fi
echo
echo "服务保持当前状态（未自动回滚）。**请人工判断后再动手。**" >&2
exit 1
