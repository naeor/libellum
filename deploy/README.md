# Libevra — 生产部署（S12-B 用）

> ⚠️ **这份配置还没有在真机上跑过。** S12-A 的任务是**准备**，不是部署；
> 服务器和域名已经买了，但**本目录里的任何一条命令都还没有在那台机器上执行过**。
> "写好了"和"验证过"是两件事，这份文档按后者标注。

---

## 1. 这套东西长什么样

```
        Internet
            │  80 / 443
            ▼
    ┌───────────────┐        ┌──────────────────────────────┐
    │  web (Caddy)  │───────▶│  api (Fastify + Prisma)      │
    │  静态包 + TLS  │ /api/* │   ├─ OCR sidecar (Python)    │
    └───────────────┘        │   └─ 语音 sidecar (Python)    │
           唯一对外端口        └──────────────┬───────────────┘
                                             │ 5432（仅内网）
                                        ┌────▼────┐
                                        │   db    │
                                        │ PG 17   │
                                        └─────────┘
```

| 服务 | 镜像 | 对外端口 | 说明 |
|---|---|---|---|
| `web` | `deploy/Dockerfile.web` | **80、443** | Caddy：静态包 + 自动 HTTPS + 反代 `/api` |
| `api` | `deploy/Dockerfile.api` | 无 | Fastify；**两个 Python sidecar 是它的子进程** |
| `migrate` | 同 `api` | 无 | 跑 `prisma migrate deploy`，跑完退出 |
| `db` | `postgres:17` | 无 | 数据卷 `db-data` |

**⚠️ 只有一个服务有公网端口。** 数据库和 API 都没有 `ports:`，
所以**只有同一个 compose 网络里的容器能连它们**。

---

## 2. 为什么 sidecar 和 API 在同一个容器里

`apps/api/src/ocr/client.ts` 与 `voice/client.ts` 各自 `spawn` 一个 Python 进程，
用 **stdin/stdout JSON** 通信——**故意的，这样识别服务不开任何端口**。

把 sidecar 拆进独立容器会强迫它开放一个网络端口，而那正是这个设计特意避开的东西。
所以 API 与两个 Python 环境同一个镜像；**代码一个字没改**，
部署侧用两个已有的环境变量告诉它解释器在哪：

```
LIBELLUM_OCR_PYTHON=/opt/libevra/python/bin/python
LIBELLUM_VOICE_PYTHON=/opt/libevra/python/bin/python
```

（这两个变量本来就在 `ocr/client.ts:38` 与 `voice/client.ts:46`，是给 Windows 开发机用的；
生产上只是换个值。）

**⚠️ 同一个解释器装两个服务。** `rapidocr-onnxruntime` + `Pillow` + `av` + `numpy` +
`pywhispercpp` 之间没有版本冲突，一个 venv 比两个小也简单。
将来若冲突，拆成两个路径并把上面两个变量指开即可。

---

## 3. 服务器资源：**需要你确认的部分**

⚠️ **文档里没有服务器规格。** 以下是从现有文档能查到的，其余需要你提供：

| 项 | 已知 / 需要 |
|---|---|
| 服务商 | 计划是**腾讯云香港轻量 2核2G**（`开发计划.md` §附）——**已购买，但实际配置未见文档** |
| 地区 | 香港（免 ICP，仍需公安联网备案）— **待确认** |
| 系统 | **待确认**（建议 Ubuntu 22.04/24.04 LTS 或 Debian 12） |
| CPU / 内存 / 磁盘 | **待确认**（计划 2 核 / 2 GB / 待确认） |
| 域名 | **待确认**——品牌已定 `Libevra`，**域名尚未选定**（`Libevra品牌迁移记录.md` §7） |
| DNS 服务商 | **待确认** |

### 内存估算（2 GB 机器上的关键约束）

| 组件 | 常驻内存（估） | 备注 |
|---|---|---|
| PostgreSQL 17 | 150–400 MB | 取决于 `shared_buffers`；默认 128 MB 够小规模用 |
| Node API | 120–250 MB | 无重依赖，主要是 Fastify + Prisma |
| **语音模型 `small`** | **约 500 MB–1 GB** | ⚠️ **最大的一块，而且首次使用时才加载** |
| OCR（RapidOCR ONNX） | 300–600 MB | ⚠️ 首次识别时加载，之后常驻 |
| Caddy | 20–40 MB | 可以忽略 |
| 容器开销（4 个） | 约 50–100 MB | |

**⚠️ 结论：2 GB 内存跑全套是紧的。** 两个模型**不会同时被用**，但都常驻之后，
峰值很容易撞上 2 GB 并触发 OOM killer——而 OOM 在容器里表现为**进程被静默杀掉再重启**，
症状是"用着用着 502 一下"，很难查。

**建议的降级方案（按代价从小到大）**：

| # | 方案 | 代价 |
|---|---|---|
| 1 | **`LIBELLUM_WHISPER_MODEL=base`**（148 MB 而不是 488 MB） | 中文识别准确度下降（`base` 会把"午饭"听成"五份"） |
| 2 | **加 swap**（服务器上加 2 GB） | 慢，但**不会 OOM**。轻量服务器上这是最划算的一步 |
| 3 | **只跑记账主路径**：`docker compose up -d db migrate api web`，**不启用 OCR/语音调用** | 截图识别与语音记账不可用；**记账、协作、离线同步完全不受影响** |
| 4 | 升级到 4 GB | 花钱。**不推荐作为第一选择**——先试 1+2 |

**⚠️ 我不建议在没实测内存之前买更贵的服务器。** 方案 1+2 大概能覆盖绝大多数日常使用。

---

## 4. 首次部署（S12-B）

> ⚠️ 以下每一条都还没有在真机上执行过。执行时**逐条确认输出**，不要整段粘贴。

### 4.1 服务器准备

```bash
# 系统更新与基础工具
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git ufw

# 防火墙：只开 SSH 与 HTTP/HTTPS
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status

# Docker（官方脚本）
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"   # 重新登录后生效
```

**⚠️ PostgreSQL 不装在任何地方，它跑在容器里**——这样它天然不监听公网端口。

### 4.2 取代码并切到要发布的版本

```bash
sudo mkdir -p /srv && sudo chown "$USER" /srv
git clone https://github.com/naeor/libevra.git /srv/libevra
cd /srv/libevra

# ⚠️ 发布指定版本，而不是"main 的最新状态"
git log --oneline -10
git checkout <要发布的 commit>
```

### 4.3 填写生产环境变量

```bash
cd /srv/libevra/deploy
cp .env.production.example .env
# ⚠️ 把里面每一个 CHANGE_ME 都换掉。三个口令都要重新生成：
#    node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
#    node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
nano .env
chmod 600 .env
```

### 4.4 域名解析

把 `LIBEVRA_DOMAIN` 的 A 记录指向服务器 IP。**Caddy 只有在域名已经解析到本机之后才能签发证书。**

### 4.5 先验证 Caddy 配置（不要跳过）

```bash
# ⚠️ 这份 Caddyfile 从来没有被 Caddy 解析过——本机没有 Docker，也没有 Caddy。
docker run --rm -v "$PWD/Caddyfile:/etc/caddy/Caddyfile:ro" \
  -e LIBEVRA_DOMAIN=example.com caddy:2-alpine \
  caddy validate --config /etc/caddy/Caddyfile
```

**⚠️ 这一条是本次交付里唯一"写了但完全没验证过"的配置。** 如果语法有误，`up` 会在 `web`
容器里报错，而那时 HTTPS 已经不可用——**所以先 validate**。

### 4.6 起服务

```bash
cd /srv/libevra/deploy
docker compose -f docker-compose.prod.yml up -d

# 看顺序：db 健康 → migrate 跑完退出 → api 健康 → web 起
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs migrate
docker compose -f docker-compose.prod.yml logs api --tail 50
```

### 4.7 建立生产管理员（**只能由你做**）

> ⚠️ **本机开发库的 `naeor` UUID 不会被带到生产。** 生产库是空的，
> 管理员必须在服务器上按下面的顺序重新建立。**两步都要做，缺一不可。**

```bash
# 1. 用浏览器打开站点，注册你自己的账号（需要一个邀请码 —— 见下）

# 2. 生成第一个邀请码（在服务器上，容器里）
docker compose -f docker-compose.prod.yml exec api pnpm invite:create "所有者"

# ⚠️ 如果生产库是全空的，第一个邀请码需要直接建 —— 见 docs/S12-A… §7 的说明

# 3. 查出新账号的 UUID
docker compose -f docker-compose.prod.yml exec api pnpm admin:list

# 4. 两步授权（两个不同的命令，两个不同的表）
docker compose -f docker-compose.prod.yml exec api pnpm admin:grant    <UUID> --by "owner"
docker compose -f docker-compose.prod.yml exec api pnpm admin:allow    <UUID> --by "owner"

# 5. 确认
docker compose -f docker-compose.prod.yml exec api pnpm admin:list
```

**⚠️ 只做第 4 步的前一半，账号还不是管理员**——这是 1.10.23 之后的设计：
授权与允许名单是两个独立的记录，**必须都有**。

### 4.8 验收

```bash
# 健康
curl -s https://<域名>/api/v1/health
# 首页与标题
curl -s https://<域名>/ | grep -o '<title>[^<]*</title>'
# 备份并演练
./backup.sh
```

**⚠️ 然后用浏览器走一遍**：注册 → 登录 → 记一笔 → 明细 → 分析 → 离线（飞行模式）→ 联网同步。
**这些是"能不能用"的验收，脚本代替不了。**

---

## 5. 日常维护

| 要做的事 | 命令 |
|---|---|
| 看状态 | `docker compose -f docker-compose.prod.yml ps` |
| 看日志 | `docker compose -f docker-compose.prod.yml logs -f api` |
| 备份 + 演练 | `./backup.sh` |
| **发布新版本** | `./deploy.sh --version 1.10.24` |
| 从备份恢复 | `./restore.sh backups/<文件>.dump` |
| 管理员名单 | `docker compose … exec api pnpm admin:list` |

### 定时备份（每日）

```bash
crontab -e
# 每天凌晨 3:17（避开整点，免得和别人的任务撞）
17 3 * * * cd /srv/libevra/deploy && ./backup.sh >> backups/cron.log 2>&1
```

**⚠️ 本地备份不是备份策略。** 同一台机器上的备份和机器一起消失。
异地那一份（计划 30 天）在 S12-B 里要落地——最省事的做法是
`rclone` 把 `backups/` 同步到一个对象存储，或者定期 `scp` 回家里的机器。

---

## 6. 开发与发布流程

```
Windows 开发机                    GitHub                     服务器
─────────────                    ──────                     ──────
pnpm typecheck                   CI：干净库跑迁移
pnpm -r test               →     → 类型检查            →     git checkout <commit>
pnpm check:build                 → 全量测试                  ./deploy.sh --version X.Y.Z
pnpm check:docs                  → 真实构建                  健康检查不过就回滚
git push ──────────────────▶
```

**⚠️ main 更新**不会**触发部署。** CI 只证明"这个 commit 是好的"，
**上不上线由你决定**（`deploy.sh` 要求你打出具体版本号）。

**⚠️ 每一条推送都上线，等于每次推送都是一次没有验收的发布**——
而"没验收"和"没发布"在复盘时是完全不同的两件事。

### 回滚

| 情况 | 做法 |
|---|---|
| **只改了代码** | `git checkout <上一个 commit>` → `./deploy.sh --version <上一个版本>` |
| **改了 schema** | ⚠️ **回滚应用不会回滚数据库。** 先读那个迁移，判断旧代码能否在新 schema 上跑；不能就跑 `./restore.sh` 恢复整库 |

**⚠️ 迁移是只向前的。** `prisma migrate deploy` 没有 `down`。
一个删列的迁移，退回旧镜像也换不回那一列——**这就是"发布前先备份"的理由。**

---

## 7. 这套配置里**还没有**的东西

如实列出，免得被当成已完成：

| # | 缺什么 | 影响 |
|---|---|---|
| 1 | **没有在真机上跑过** | 首次部署时必然要现场调试 |
| 2 | **Caddyfile 没被 Caddy 解析过** | §4.5 的 validate 是必须的 |
| 3 | **没有异地备份** | 服务器丢 = 数据丢 |
| 4 | **没有监控与告警** | 站点挂了要你自己发现 |
| 5 | **没有自动部署** | 有意为之（见 §6） |
| 6 | **没有零停机发布** | 单机单实例，`up -d` 期间有秒级中断 |
| 7 | **公安联网备案没做** | 上线后 30 天内（`技术方案.md` §10.4） |
| 8 | **页脚没有备案号位置** | `apps/web/src` 里没有相关代码（`开发计划.md` 已记） |

---

## 8. 安全边界

| 权限 | 由谁管 | 与其它两套的关系 |
|---|---|---|
| **应用管理员** | `admin_grants` + `admin_allowlist`（见 `docs/开发过程记录/管理员与权限边界-设计决定.md`） | 完全独立 |
| **账本 Owner/Editor/Viewer** | `book_members` | 完全独立；**管理员不自动获得成员权** |
| **服务器 / 数据库** | SSH、`docker` 组、PostgreSQL 超级用户 | 完全独立；**应用管理员不自动获得这些** |

**⚠️ `docker` 组的成员等价于 root。** 服务器上能用 `docker` 的人可以挂载宿主机的 `/`
并改任何东西。所以**给部署用的账号要当 root 对待**，别因为"它只是跑容器"而放松。

**⚠️ 数据库口令不是应用管理员的认证方式。** 知道口令的人能改库，
但**不能**通过任何 HTTP 接口获得管理员权限——两件事没有通道。
---

## 🗄️ 自动备份（S12-C，2026-10-17 新增）

生产备份由三层组成，**每层失败原因不同，所以状态分开记录**：

| 文件 | 作用 |
|---|---|
| `backup.sh` | 本地备份 + **隔离恢复演练** + 轮转 + 写 `backups/last-local.json` |
| `backup-all.sh` | 编排：调 `backup.sh` → **AES-256 加密** → 上传 COS → **下载回来比对 SHA-256** → 写 `backups/last-run.json` → 失败告警 |
| `offsite-fetch.sh` | **灾难恢复用**：从 COS 取回并解密（只读，不碰数据库） |
| `alert-mail.sh` | **邮件告警**（Resend HTTPS API，带去重与恢复通知） |
| `heartbeat.sh` | **外部心跳**（Healthchecks.io；服务器彻底失效时由外部报警） |
| `verify-dump.sh` | 把任意 dump 恢复到**隔离临时库**并与记录的行数对照 |
| `monthly-offsite-drill.sh` | **月度异地演练**：取回→解密→隔离恢复→对照（在你自己的机器上跑） |
| `systemd/` | `libevra-backup.service` / `.timer`（**仓库副本，安装见下**） |

### 三个秘密文件（**不进仓库**，权限 `600`）

| 文件 | 内容 |
|---|---|
| `deploy/.backup.key` | 加密口令（`openssl rand -base64 32`）。**丢了 = 异地备份全废**，必须有服务器之外的副本 |
| `deploy/.backup.env` | **上传身份**：`COS_UPLOAD_ID` / `COS_UPLOAD_KEY` / `COS_BUCKET` / `COS_REGION` / `COS_ENDPOINT` |
| `deploy/.backup-mail.env` | `MAIL_API_KEY` / `MAIL_TO` / `MAIL_FROM`（Resend） |
| `deploy/.backup-heartbeat.env` | `HEARTBEAT_URL`（Healthchecks.io） |
| `deploy/.backup-restore.env` | **恢复身份**（`COS_RESTORE_*`）——**不放在生产服务器** |

**⚠️ 上传身份只给"写 + HeadObject"；恢复身份（只读）不放在服务器上。权限清单与实测依据见 `docs/开发过程记录/S12-C-B-实施与配置指南.md` §1。**
30 天过期由**桶的生命周期规则**在服务端执行 —— 即使服务器被入侵，历史备份也删不掉。

### 安装定时任务（**先手动跑通，再 `enable`**）

```bash
sudo cp deploy/systemd/libevra-backup.service /etc/systemd/system/
sudo cp deploy/systemd/libevra-backup.timer   /etc/systemd/system/
sudo systemctl daemon-reload

# ⚠️ 先手动跑一次，确认三项状态都是 true 再启用
cd /srv/libevra/deploy && ./backup-all.sh

# 启用（每天 03:00 香港时间；Persistent=true 会补跑关机错过的）
sudo systemctl enable --now libevra-backup.timer
systemctl list-timers libevra-backup.timer --no-pager
```

### 查看与暂停

```bash
journalctl -u libevra-backup -n 100 --no-pager     # 最近一次的输出
cat /srv/libevra/deploy/backups/last-run.json      # 三项状态（本地/演练/异地）
sudo systemctl stop libevra-backup.timer           # 暂停（备份不再自动跑）
sudo systemctl start libevra-backup.timer          # 恢复
```