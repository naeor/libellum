# Libellum 开发日志（DEVLOG）

> **项目**：Libellum —— 开源、免费的记账 Web 应用
> **仓库**：<https://github.com/naeor/libellum>（公开，创建于 2026-10-08 15:11:48）
> **本地路径**：`C:\Users\ZhuanZ（无密码）\Desktop\工作\记账程序`
> **日志起始**：2026-10-08

---

## 0. 记录约定

| 项 | 约定 |
|---|---|
| 时区 | 全部为 **Asia/Shanghai（UTC+8）** |
| 时间精度 | 「**精确**」= 取自文件系统时间戳或会话时间采样点；「**约**」= 由相邻采样点推算，误差约 ±3 分钟 |
| **禁止记录** | **本日志不写任何密码、密钥、Token**。所有凭据只存在于 `.env`（已被 `.gitignore` 排除），仓库里只有 `.env.example` 模板 |
| 记录粒度 | 每条包含：时间 / 类型 / 改了什么 / 为什么 / 怎么验证 |
| 类型标记 | `决策` `文件` `环境` `调研` `修复` `清理` |

### 0.1 交互需求预告协议（2026-10-08 约 15:15 由项目所有者提出）

**起因**：本次环境搭建过程中出现 **2 次需要用户确认的弹窗**（PostgreSQL 17 与 GitHub CLI 的安装提权）。项目所有者当时不确定是否需要守在电脑旁、是否需要交出设备控制权，因此提出：**执行任务前先说明这一步的交互需求**。

**约定**：每一步开始前，必须用下列标记说明该步骤是否需要用户参与。

| 标记 | 含义 | 需要用户做什么 |
|---|---|---|
| 🟢 **全自动** | 只在本机读写文件、执行命令；不会出现任何窗口、弹窗或授权页 | 可以去忙别的，不必守着 |
| 🟡 **可能有窗口** | 可能弹出 UAC 提权、浏览器授权页或安装向导 | 建议在电脑旁，看到弹窗点"是"或完成授权 |
| 🔴 **需要你操作** | 必须由本人完成：登录、付款、真机测试、实名备案、文字润色、拍板决策 | 我暂停并等你 |

**附加约定**：不主动安装系统级软件、不主动改动系统设置；确需如此时，先说明原因、影响与替代方案，再动手。

---

## 1. 时间线总表

### 1.1 第一阶段：方案选型与初版文档（12:50 – 13:15）

| 时间 | 类型 | 变更 / 动作 | 详情与理由 | 验证依据 |
|---|---|---|---|---|
| 12:50 | 调研 | 会话开始，提问澄清需求 | 用户问"做网页还是 APK"。第一轮 6 问：设备 / 使用人数与同步 / 离线 / 原生功能 / 分发方式 / 技术栈 | 会话时间采样 |
| 12:50 | 调研 | 第一轮答复回收 | 只有安卓手机；先一人用以后可能加人；**要求每人独立账号密码登录**；要拍照小票 / 提醒 / 导出 Excel；能接受直接装 APK；**开发者自述不会编程、无安卓真机** | 会话 |
| 约 12:52 | 环境 | 勘察本机开发环境 | Node v24.20、JDK 25（Temurin）、Android Studio 已装、adb 1.0.41、Android SDK 位于 `C:\Android\Sdk`、已有 3 个 Pixel 9 模拟器（`Pixel_9`/`Pixel_9_2`/`Pixel_9_3`）。当时 `ANDROID_HOME` 为空 | `pwsh` 实测输出 |
| 约 12:54 | 调研 | 第二轮提问（4 问） | 是否要服务器 / 提醒的重要性 / v1 功能范围 / 下一步交付什么 | 会话 |
| 约 12:56 | 调研 | 第二轮答复回收 | 预算 ≤ ¥100/月；**不要提醒通知**；勾选"账号密码登录 / 拍照小票 / 收支都记 / 导出 / 统计图表 / 多人共享账本"；**要先要一份详细方案文档** | 会话 |
| 13:00 | 调研 | 派出后台调研任务 #1 | 核实 2026-10 的服务器 / 域名 / Supabase 真实价格与配额，避免凭记忆写错数字 | 后台子代理 |
| **13:08:01** | **文件** | **创建项目目录** `Desktop\工作\记账程序` | 用户指定目录，此时间戳为目录创建时间 | 目录 CreationTime（精确） |
| 约 13:09 | 文件 | 创建 `pocket-ledger/docs/PLAN.md`（v1.0） | 技术方案初版：形态选型、架构、数据库、API、安全、里程碑、简历包装 | 会话 |
| 13:03:50 | 文件 | 创建 `tools/md2docx.py` | 自写 Markdown→Word 转换器（支持标题 / 表格 / 列表 / 复选框 / 代码块 / 粗体 / 行内代码），用于产出可阅读的 Word 版文档 | 文件时间戳（精确） |
| 约 13:05 | 修复 | 发现 DOCX 渲染异常 | 转出的 Word 在预览中**右侧内容被截断**（5 列表格溢出、连标题都被切） | 渲染截图 |
| 约 13:06 | 修复 | 排除 `w:docGrid` 嫌疑 | 做对照实验：`grid_default` / `grid_none` / `no_grid` 三个 docx 渲染结果**哈希完全相同**，证明 docGrid 不是原因 | 三个 PNG 的 SHA256 一致 |
| 约 13:08 | 修复 | 用"标尺法"定位根因 | 插入一张精确 5cm×1cm 的纯黑图片，实测渲染为 **284px**（而非 96dpi 应有的 189px）→ 实际以 **144dpi** 出图（= 本机 Windows 150% 缩放），却被按 96dpi 裁切。**结论：文档本身没问题，是预览管线在这台机器上有缺陷** | Pillow+numpy 像素测量 |
| 约 13:10 | 修复 | 改用可信预览通道 | DOCX → PDF（LibreOffice 导出，MediaBox 实测为标准 A4 `595.3×841.9pt`）→ pdfium 渲染，几何完全正确（5cm 标尺 = 190px）。此后所有版面校验都走 PDF 通道 | PDF MediaBox 解析 + 像素测量 |
| 约 13:12 | 文件 | 合并调研 #1 数据 | 写入 10.2 价格明细：Supabase 免费版 7 天不活跃即暂停、`*.pages.dev` 大陆不稳、Vercel 官方承认大陆可能失败、GitHub 学生包中 DigitalOcean 已于 2026-07-31 退出 | 调研报告 URL |
| 约 13:14 | 文件 | 生成 v1 的 `PocketLedger-技术方案.docx/pdf` | 首版交付物 | 文件时间戳 |

### 1.2 第二阶段：迁移、开源定位与制作计划（13:15 – 14:09）

| 时间 | 类型 | 变更 / 动作 | 详情与理由 | 验证依据 |
|---|---|---|---|---|
| 13:15 | 调研 | 用户第 2 轮指示（9 条） | ①迁移到 `Desktop\工作\记账程序` ②自述有 CSA + Python 基础 ③**UCSB 大二在读学生** ④后端自建 ⑤定位改为"开源、免费的记账工具 + 简历作品" ⑥服务器要**国内能轻松访问**（家人要用） ⑦起个简约英文名 ⑧要公开 Demo ⑨**先出制作计划，不急着开发** | 会话 |
| **13:15:51** | **文件** | **迁移文件到新目录** | `pocket-ledger/` 下 4 个文件复制到 `Desktop\工作\记账程序\docs|tools`，**逐个 SHA256 比对一致**后删除旧目录 | 哈希校验输出（精确） |
| 13:15 | 调研 | 派出后台调研任务 #2、#3 | #2 候选英文名查重；#3 个人 ICP 备案可行性与大陆访问质量 | 后台子代理 |
| **13:17:46** | **文件** | **创建 `docs/ROADMAP.md`** | 制作计划与大纲：S0–S8 九阶段、任务清单、逐条验收标准、协作方式、风险登记册、两种时间节奏 | 文件 CreationTime（精确） |
| **13:19:55–13:19:59** | **文件** | 生成 `技术方案.docx/pdf`、`制作计划与大纲.docx/pdf` | 从 Markdown 源渲染，供阅读与打印 | 文件时间戳（精确） |
| 约 13:21 | 修复 | 文档一致性自查 | 用 grep 搜 `共享|邀请码|成员|viewer|editor` 共 51 处命中，发现 **7 处残留不一致**（时间表仍写"S6 共享账本"、表头仍写"多人共享的核心"等），逐个修正 | grep 结果 |
| 2026-10-08 13:20:23 | 文件 | 创建 `tools/check_names.py` | 命名可用性探测器：npm registry + GitHub + RDAP 域名 | 文件时间戳（精确） |
| 约 13:22 | 修复 | 修正探测标准 | 首轮把"GitHub 用户名空闲"当硬指标，结果 30/30 全部 TAKEN；用随机字符串对照验证探测逻辑无误 → **是该标准本身不适用**（短单词用户名早被抢光），改为以"域名 + 无同名产品"为主标准 | 对照组实验 |
| 13:31:16 | 文件 | 重写 `tools/check_names.py` | 改为多后缀域名（.com/.app/.dev/.io/.xyz）+ npm 双维度 | 文件时间戳（精确） |
| 13:32:16 | 文件 | 创建 `tools/check_names2.py` | 拉丁名候选的多后缀批量查询 | 文件时间戳（精确） |
| 约 13:25 | 文件 | 落实用户的范围变更 | v1 改为**一个账号一本独立账本**；共享账本移入 v2；**表结构从第一天按可共享建**（`books` + `book_members` + `invites`，v1 只用 owner 一行） | 文档 diff |
| 13:35 | 调研 | 拉丁语命名与商标调研回收 | `liber rationum` 成立但属 16–17 世纪用法；`liber` 是同形异音双关；**Liberum 撞英国投行 Panmure Liberum 且五个后缀域名全被占**；`Libri` 有英国软件类商标；`Rationum` 商店已有同名记账 App；**Libellus / Libellum 无金融类撞名** | 调研报告（附 URL） |
| 约 13:40 | 文件 | 重写 PLAN §13 命名章节 | 增加 13.3 拉丁语方向核实、13.4 定名建议、13.5 核实边界 | 会话 |
| 约 13:45 | 文件 | 增补 ROADMAP | S0 增加"git 怎么配""PostgreSQL 怎么装"详细步骤；S6 由"共享账本"改为"设置页 + 演示账号"；工期 8–10 天 → 7–9 天；风险表新增第 12 条（家人以后可能要求共用一本账） | 会话 |
| 约 13:50 | 环境 | 实测本机依赖现状 | **Docker 未装、WSL2 未装**（`wsl --status` 提示需先 `wsl --install` 并重启）、虚拟化与 Hyper-V 已开启、`winget` 可用、`corepack 0.35.0` 可用 → 决定**本地装原生 PostgreSQL，不用 Docker** | pwsh 实测 |

### 1.3 第三阶段：定名 Libellum、装数据库、初始化仓库（14:09 – 15:07）

| 时间 | 类型 | 变更 / 动作 | 详情与理由 | 验证依据 |
|---|---|---|---|---|
| 14:09 | 调研 | 用户第 4 轮指示 | 名字定 **Libellum**；表结构按可共享建；**装原生 PostgreSQL 17**；协议**倾向 AGPL**；`naelo` 用户名已被占，要新的候选 | 会话 |
| **14:09:41** | **文件** | 创建 `tools/check_usernames.py` | GitHub 用户名可用性探测器（`github.com/<name>` 返回 404 即空闲） | 文件 CreationTime（精确） |
| 约 14:10 | 环境 | **后台安装 PostgreSQL 17** | `winget install --id PostgreSQL.PostgreSQL.17 -e` + 无人值守参数（`--mode unattended --superpassword ...`）；随机生成超级用户密码 | winget 退出码 0 |
| 约 14:10–14:12 | 调研 | 用户名两批查询 | 第一批 53 个候选 → 仅 2 个空闲；第二批 45 个 → 7 个空闲。**合计 98 个候选，9 个可用** | 脚本输出 |
| **14:12:46** | **文件** | 更新 `docs/ROADMAP.md` | 第 9 章改为"只差 GitHub 用户名"，附 9 个候选与推荐；§4 前置条件表更新 | 文件时间戳（精确） |
| **14:12:57** | **文件** | 更新 `docs/PLAN.md` | 标题改为 `Libellum 记账应用 · 技术方案`；摘要写入项目名与协议；§11.2 重写为 AGPL-3.0 并列出三条取舍；§13.4 改为"定名结论" | 文件时间戳（精确） |
| **14:13:02–14:13:11** | **文件** | 重新渲染两份文档 | `技术方案` 27 页、`制作计划与大纲` 14 页；结构检查双 pass；**逐页版面检查零溢出** | 文件时间戳 + 校验输出（精确） |
| 约 14:14 | 环境 | PostgreSQL 17 安装完成 | 版本 **17.11**，编码 **UTF8**，服务名 `postgresql-x64-17`，状态 **Running**、启动类型 **Automatic**（开机自启） | `Get-Service` + `SELECT version()` |
| **14:14:36** | **文件** | 写入 `.env` | 应用连接串与开发用会话密钥（**真实凭据，已被 git 忽略**） | 文件 CreationTime（精确） |
| 约 14:14 | 环境 | 创建数据库对象 | 角色 `ledger`、库 `ledger_dev`（开发）、`ledger_test`（测试，测试会清库，与开发库隔离）；用新角色实连验证 `ledger @ ledger_dev` 通过 | psql 输出 |
| **14:14:45** | **文件** | 创建 `.gitignore` `.gitattributes` `.env.example` | 保护密钥；换行符统一 LF（`* text=auto eol=lf`，Windows 脚本保留 CRLF）；模板文件说明需要哪些环境变量 | 文件时间戳（精确） |
| **14:14:57** | **文件** | 修订 `.gitignore` | 新增排除 `docs/*.docx`、`docs/*.pdf`（Markdown 是源，导出件不必进仓库），并注明"想让简历看到 PDF 就删掉这两行" | 文件时间戳（精确） |
| 约 14:15 | 环境 | `git init` | 初始化本地仓库，默认分支 `main` | git 输出 |
| 约 14:16 | 修复 | **密钥泄漏防护验证** | `git check-ignore -v .env` 命中规则 `.gitignore:11:.env`；`git add -A --dry-run` 清单中**确认没有 `.env`** | 命令输出（关键安全验证） |
| 约 14:17 | 环境 | 复核服务自启 | `postgresql-x64-17` 启动类型为 `Automatic`（重启机器后自动可用） | `Get-Service` |
| 15:07 | 调研 | 用户第 5 轮指示 | 用户名用 **naeor**（已在 GitHub 注册完成）；提供 noreply 邮箱；要求新建开发日志并完整记录全部改动 | 会话 |

### 1.4 第四阶段：git 身份 + 开发日志（15:07 – 现在）

| 时间 | 类型 | 变更 / 动作 | 详情与理由 | 验证依据 |
|---|---|---|---|---|
| **约 15:08** | **环境** | **配置 git 提交身份** | `user.name=naeor`，`user.email=339472656+naeor@users.noreply.github.com`。用 GitHub 的 **noreply 邮箱**：提交不暴露真实邮箱，GitHub 仍把提交算到账号上（GitHub 官方提示"命令行 Git 操作必须自行设置邮箱才能使用私有邮箱"） | `git config --global --list`（精确） |
| 约 15:09 | 环境 | 后台安装 GitHub CLI | `winget install --id GitHub.cli -e`，用于一条命令建仓库、发 Release | winget 输出 |
| **15:08:36** | **文件** | **创建 `docs/DEVLOG.md`（本文件）** | 按用户要求，把本日全部改动按时间顺序详细记录，含时间、类型、改了什么、为什么、验证方式 | 文件 CreationTime（精确） |
| 约 15:08:50 | 环境 | GitHub CLI 安装完成 | gh **2.102.0**（2026-09-30 版） | `gh --version` |
| 约 15:08:55 | 环境 | 发起 GitHub 设备码授权 | `gh auth login --web`（在非交互终端下同样可用），输出一次性设备码与 `https://github.com/login/device`，等待用户在浏览器确认。**设备码属一次性凭据，本日志不记录** | gh 输出 |
| **15:09:06** | **文件** | 生成 `开发日志.docx/pdf` | 开发日志可读版；**17 页**，结构检查通过、版面零溢出 | 文件时间戳（精确） |
| **15:09:20** | **版本** | **首次提交 `8689706107`** | `chore: bootstrap project docs, tooling and dev log` —— 10 个文件、2105 行新增。提交前用 `git check-ignore` + `git add --dry-run` **双重确认 `.env` / `.docx` / `.pdf` 均未被提交** | git commit 对象（精确） |
| **15:10:06** | **版本** | 第二次提交 `fb9071f` | `docs: record bootstrap commit and GitHub auth in dev log`（+18 −4 行）：把首次提交哈希与授权过程补入本日志 | git commit 对象（精确） |
| **15:11:38** | **环境** | **GitHub 设备码授权完成** | 用户在浏览器确认设备码后，gh 将凭据写入系统 keyring；账号 `naeor`，token 权限 `repo` / `gist` / `read:org`，git 协议 https | `gh auth status` + `hosts.yml` 时间戳（精确） |
| **15:11:48** | **版本/环境** | **创建公开仓库** | `gh repo create libellum --public --source . --push` → <https://github.com/naeor/libellum>，默认分支 `main`，可见性 PUBLIC | GitHub API `created_at`（精确） |
| **15:11:54** | **版本** | **首次推送完成** | 两个提交推送到远程 `main`；随后设置仓库描述与 **11 个话题标签**；远程文件树核对确认**不含 `.env`、不含 docx/pdf** | GitHub API `pushed_at` + 文件树接口（精确） |
| **15:12:41** | **文件** | 创建 `LICENSE` | AGPL-3.0 官方全文（34,526 字节），经 GitHub Licenses API 获取，**未改动一字**；版权声明写在 README 而不去改动许可证正文 | 文件时间戳（精确） |
| **15:12:54** | **文件** | 创建 `README.md` + `README.zh-CN.md` | 公开仓库的门面：英文主文档 + 中文版。明确标注「早期开发中、尚不可部署」以免误导；含名字来历（liber = 书/自由）、技术栈、文档索引、隐私声明、AGPL 释义 | 文件时间戳（精确） |
| 约 15:15 | 决策 | 项目所有者提出「**交互需求预告协议**」 | 安装期间出现 2 次需确认的弹窗，所有者不确定是否需在旁等待或交出设备控制权 → 要求每步执行前标注交互需求。已固化为 §0.1 | 用户消息 |
| 约 15:16 | 环境 | 发现并解决 `npm` 无法直接调用的问题 | PowerShell 执行策略禁止运行 `npm.ps1`（本机执行策略全部为默认受限）。**改用 `npm.cmd` 正常**（npm 11.19.0）。已记入 §6 | 实测 |
| 约 15:16 | 环境 | 探明「免提权安装 pnpm」的路径 | ① `corepack enable` 需写 `C:\Program Files\nodejs` → **会弹 UAC**；② 但 npm 全局目录 `%APPDATA%\npm` 位于用户目录内且**已在 PATH 中** → `npm.cmd i -g pnpm` **无需提权、无弹窗**。结论：后续开发步骤均可标 🟢 | 目录写入测试实测 |

### 1.5 第五阶段：S1 骨架（15:19 – 15:28）

> 本阶段全程 🟢 全自动，未产生任何弹窗，用户无需在旁等待。

| 时间 | 类型 | 变更 / 动作 | 详情与理由 | 验证依据 |
|---|---|---|---|---|
| 15:19 | 决策 | 用户批准开工，并要求事后解释 GitHub 授权 | 授权解释见 §10 | 用户消息 |
| 约 15:20 | 环境 | 安装 pnpm **12.10.1** | `npm.cmd install -g pnpm`，写入 `%APPDATA%\npm`（免提权） | `pnpm --version` |
| **15:20:48** | **文件** | 创建 workspace 根配置 | `package.json`（workspace 脚本）、`pnpm-workspace.yaml`（含 `onlyBuiltDependencies`）、`.npmrc`、`tsconfig.base.json`（strict + Bundler 解析） | 文件时间戳（精确） |
| **15:20:59** | **文件** | `packages/shared`：金额工具 | `src/money.ts` —— 整数「分」的解析 / 格式化 / 累加；全项目金额只走整数，杜绝浮点误差 | 文件时间戳（精确） |
| **15:21:21** | **文件** | `apps/api` 骨架 | `src/app.ts`（构造与 `listen` 分离，便于 `inject` 测试）、`src/env.ts`（环境变量校验）、`src/routes/health.ts`、`src/server.ts`、`test/health.test.ts` | 文件时间戳（精确） |
| **15:21:41** | **文件** | `apps/web` 骨架 | React 19 + Vite 8 + Tailwind 4；`App.tsx` 请求 `/api/v1/health` 并用共享 Zod schema 校验响应 | 文件时间戳（精确） |
| **15:22:04** | **文件** | 单测与 CI | `money.test.ts`（含 `0.1+0.2` 与 1000 次 `0.01` 累加）、`health.test.ts`、`.github/workflows/ci.yml`（typecheck → migrate → test → build） | 文件时间戳（精确） |
| 约 15:22 | 环境 | 安装全部依赖 | react 19.3 / vite 8.3.3 / tailwindcss 4.3.3 / fastify 5.12.5 / vitest 5.0.3 / zod 4.6.5 / typescript 7.0.2 | `pnpm list -r` |
| **15:23:34** | **文件** | 创建 Prisma schema | `prisma/schema.prisma`：`User`、`Session` 两个模型，对应 PLAN §5.1 | 文件时间戳（精确） |
| **15:24:18** | **文件** | 创建 `prisma.config.ts` | Prisma 7 把连接串移出了 schema | 文件时间戳（精确） |
| **15:24:44** | **文件** | 创建 `apps/api/src/db.ts` | Prisma 7 必须传驱动适配器 | 文件时间戳（精确） |
| 约 15:25 | 修复 | 处理三处依赖/版本问题 | 见 §6：prisma RC 版本、Prisma 7 接口变更、YAML 编码隐患 | 见 §6 |
| 约 15:25 | 环境 | 授予 `ledger` 角色 **CREATEDB** 权限 | `prisma migrate dev` 需要创建影子数据库 | psql `ALTER ROLE` |
| **15:24:57** | **环境** | 生成并应用首个迁移 | `20261008072457_init`；`ledger_dev` 中建出 `users`、`sessions`、`_prisma_migrations` 三张表 | `\dt` 输出（精确） |
| 约 15:26 | 验证 | 类型检查 + 单元测试 | 三个包 `tsc --noEmit` 全通过；**测试 28 个全通过**（shared 24 + api 4） | 命令输出 |
| 约 15:26 | 修复 | Vite 默认只监听 IPv6 | 见 §6 | netstat 实测 |
| **约 15:27** | **验证** | **端到端验证通过** | 直连 API 返回 `{"ok":true,"service":"libellum-api","database":"up"}`（**真实连上 PostgreSQL**）；前端首页 HTTP 200；**经 Vite 代理请求 `/api/v1/health` 同样 200** —— 证明「浏览器 → Vite 代理 → Fastify → Prisma → PostgreSQL」整条链路打通 | curl 输出 |
| **15:27:42** | **版本** | **提交 `326bf3e`** | 35 个文件、4263 行新增，已推送；GitHub Actions 随之触发 | git commit 对象（精确） |
| 约 15:28 | 修复 | 清理漏网临时文件 | `_web.err` / `_web.log` 曾进入待提交列表 | `git add --dry-run` |

---

## 2. 关键决策记录（ADR）

| 编号 | 时间 | 决策 | 理由 | 后续影响 |
|---|---|---|---|---|
| ADR-001 | 约 12:56 | **形态选 Web，不做原生 APK** | ①账号系统决定了必须有服务端，APK"不用服务器"的优势不存在 ②开发者无安卓真机，APK 每次改 bug 要打包-签名-传文件-重装 ③导出 Excel、多人共享都是网页更强 ④开源项目让陌生人 clone 就能跑 | APK 留作 v2，用 Capacitor 套壳即可，前端零重写 |
| ADR-002 | 约 13:56 | **后端自建**（不用 Supabase 一栈到底） | 开发者选择"方便后期修改"；且自建在简历上可讲度高；Supabase 免费版 7 天不活跃即暂停、Pro $25/月超预算 | 需要自己配服务器与安全 |
| ADR-003 | 约 13:35 | **部署在香港轻量服务器** | 家人必须能稳定访问；香港节点**免 ICP 备案**（阿里云官方 FAQ 明文），而个人主体做交互式服务的 ICP 备案有被驳回风险 | **上线后 30 天内必须办公安联网备案**（境外服务器向大陆提供服务同样适用） |
| ADR-004 | 约 13:50 | **本地装原生 PostgreSQL 17，不装 Docker** | 本机 Docker 与 WSL2 均未安装，装 Docker Desktop 需先 `wsl --install` 并重启；原生 PG 一条命令即可。生产仍用 `postgres:17` 容器，**同一大版本**，SQL 与迁移一致 | 免去 WSL2 与内存开销 |
| ADR-005 | 约 13:25 | **v1：一个账号一本独立账本；共享账本移入 v2** | 用户明确"先开发每个账号对应独立的账本"，共享会牵出成员管理、权限矩阵、邀请码、并发冲突一整套界面 | **表结构从第一天按可共享建**（`books` / `book_members` / `invites`），v2 只写界面与接口，不改表、不迁移数据 |
| ADR-006 | 14:09 | **项目名 Libellum** | 拉丁语 `liber` 同时是"书"和"自由"，指小词 `libellus/libellum` 意为"小簿子、日记账"；且是 liber 系里**唯一没有金融类撞名**的；`libellum.app` 经 RDAP 核实未注册 | 仓库名 `libellum`，域名 `libellum.app`，标语 `the free, open ledger` |
| ADR-007 | 14:09 | **开源协议 AGPL-3.0** | 与"开源、免费、防止被拿去做闭源生意"的定位一致 | 需知：部分公司对 AGPL 有政策限制；协议可逆，换 MIT 只需改 `LICENSE` |
| ADR-008 | 约 13:12 | 技术栈定稿 | 前端 React 19.2 + Vite 8 + TypeScript + Tailwind；后端 Node 22/24 + Fastify + Prisma + PostgreSQL 17；容器 Docker Compose + Caddy 自动 HTTPS | 全项目统一 |
| ADR-009 | 约 12:56 | **开源但不开注册** | 避免陌生人注册滥用服务器与数据风险；注册用邀请码，对外只提供**只读演示账号**（`is_demo`，服务端拦截写操作，数据每日重置） | S6 实现 |
| ADR-010 | 约 13:08 | 文档版面校验统一走 **PDF 通道** | DOCX→位图 在本机受 Windows 150% 缩放影响会错裁；DOCX→PDF→位图 几何正确 | 所有后续版面检查均用此法 |

---

## 3. 环境变更记录（本机）

| 时间 | 对象 | 变更内容 | 当前状态 |
|---|---|---|---|
| 12:52 | Node / JDK / Android Studio | **未改动**，仅勘察 | Node v24.20、JDK 25、Android Studio + SDK `C:\Android\Sdk`、adb、3 个 Pixel 9 模拟器 |
| 约 15:08 | git 全局配置 | 新增 6 项：`user.name`、`user.email`、`init.defaultBranch=main`、`push.autoSetupRemote=true`、`core.autocrlf=false`、`pull.rebase=false` | 全部生效 |
| 约 14:10 | PostgreSQL 17 | **新安装** 17.11（winget，无人值守） | 目录 `C:\Program Files\PostgreSQL\17` |
| 约 14:14 | PostgreSQL 服务 | 注册为 Windows 服务 `postgresql-x64-17` | Running / **Automatic** |
| 约 14:14 | PostgreSQL 对象 | 新建角色 `ledger`；新建库 `ledger_dev`、`ledger_test` | 已用新角色实连验证通过 |
| 约 15:09 | GitHub CLI | 后台安装 `GitHub.cli` | 安装中/已装 |
| — | Docker Desktop / WSL2 | **主动决定不安装** | 未安装（见 ADR-004） |

> **密码管理说明**：PostgreSQL 的超级用户密码与应用角色密码**只写在 `.env` 和交付给项目所有者本人**，本日志与仓库中一律不出现。若需轮换，重新生成后更新 `.env` 即可。

---

## 4. 文件清单

| 创建时间 | 最后修改 | 文件 | 说明 |
|---|---|---|---|
| 13:03:50 | 13:03:50 | `tools/md2docx.py` | Markdown→Word 转换器（自写） |
| 13:15:51 | 14:12:57 | `docs/PLAN.md` | 技术方案（v2.1，27 页导出） |
| 13:17:46 | 14:12:46 | `docs/ROADMAP.md` | 制作计划与大纲（14 页导出） |
| 13:19:55 | 14:13:02 | `docs/技术方案.docx` | 技术方案 Word 版（**不进仓库**） |
| 13:19:56 | 14:13:06 | `docs/技术方案.pdf` | 技术方案 PDF 版（**不进仓库**） |
| 13:19:59 | 14:13:04 | `docs/制作计划与大纲.docx` | 制作计划 Word 版（**不进仓库**） |
| 13:19:59 | 14:13:11 | `docs/制作计划与大纲.pdf` | 制作计划 PDF 版（**不进仓库**） |
| 13:20:23 | 13:31:16 | `tools/check_names.py` | 命名可用性探测（npm + 域名） |
| 13:32:16 | 13:32:16 | `tools/check_names2.py` | 拉丁名候选多后缀查询 |
| 14:09:41 | 14:09:41 | `tools/check_usernames.py` | GitHub 用户名可用性探测 |
| 14:14:36 | 14:14:36 | `.env` | 本地凭据（**已被 git 忽略**） |
| 14:14:45 | 14:14:45 | `.gitattributes` | 换行符与二进制文件规则 |
| 14:14:45 | 14:14:57 | `.gitignore` | 排除依赖/构建产物/密钥/导出件 |
| 14:14:45 | 14:14:45 | `.env.example` | 环境变量模板（可进仓库） |
| 15:08:36 | 15:09:27 | `docs/DEVLOG.md` | 本开发日志 |
| 15:09:06 | 15:09:06 | `docs/开发日志.docx` | 开发日志 Word 版（**不进仓库**） |
| 15:09:06 | 15:09:08 | `docs/开发日志.pdf` | 开发日志 PDF 版（**不进仓库**） |
| 15:12:41 | 15:12:41 | `LICENSE` | AGPL-3.0 官方全文（34.5 KB，未改动） |
| 15:12:54 | 15:12:54 | `README.md` | 英文主 README（公开仓库门面） |
| 15:12:54 | 15:12:54 | `README.zh-CN.md` | 中文 README |

> 项目根目录 `Desktop\工作\记账程序` 创建于 **2026-10-08 13:08:01**；项目根目录下的 `.git` 由 `git init` 于约 14:15 建立。

### 4.1 提交历史

| 提交 | 时间 | 信息 | 内容 |
|---|---|---|---|
| `8689706107` | 2026-10-08 15:09:20 | `chore: bootstrap project docs, tooling and dev log` | 10 个文件 / 2105 行：`.env.example`、`.gitattributes`、`.gitignore`、`docs/DEVLOG.md`、`docs/PLAN.md`、`docs/ROADMAP.md`、`tools/` 下 4 个脚本 |
| `fb9071f` | 2026-10-08 15:10:06 | `docs: record bootstrap commit and GitHub auth in dev log` | 1 个文件 / +18 −4 行：补入首次提交哈希与授权过程 |

> 作者身份：`naeor <339472656+naeor@users.noreply.github.com>`（使用 GitHub noreply 邮箱，提交中不暴露真实邮箱）
> 远程仓库：<https://github.com/naeor/libellum>（公开；创建 15:11:48，首次推送 15:11:54）
> 本表记录"到最近一次提交为止"的历史；**最新一次提交本身会在下一次提交时补入**（避免提交哈希自我引用）。
> 话题标签：`bookkeeping` `expense-tracker` `family-finance` `fastify` `open-source` `personal-finance` `postgresql` `prisma` `react` `self-hosted` `typescript`

### 4.2 项目骨架（S1 交付，提交 `326bf3e`）

```
记账程序/                        # 仓库根（GitHub 上名为 libellum）
├─ apps/
│  ├─ api/                       # Fastify 后端
│  │  ├─ src/app.ts              # buildApp()：构造与 listen 分离，便于测试
│  │  ├─ src/server.ts           # 入口：读配置 → 建 app → listen → 优雅退出
│  │  ├─ src/env.ts              # 环境变量读取与校验（缺了就报错，不给静默默认值）
│  │  ├─ src/db.ts               # Prisma 7 客户端 + @prisma/adapter-pg
│  │  ├─ src/routes/health.ts    # GET /api/v1/health
│  │  ├─ src/generated/prisma/   # Prisma 生成物（.gitignore 已排除）
│  │  └─ test/health.test.ts     # 4 个接口测试，用 app.inject()，不需要数据库
│  └─ web/                       # React 前端
│     ├─ src/App.tsx             # S1 占位页：调 API 并用共享 schema 校验
│     ├─ src/main.tsx            # 挂载入口
│     ├─ src/index.css           # Tailwind 4 入口
│     └─ vite.config.ts          # 绑 127.0.0.1 + /api 代理到后端
├─ packages/
│  └─ shared/                    # 前后端共享
│     └─ src/{money,health,index}.ts   # 整数分金额工具 + Zod schema
│     └─ src/{money,health}.test.ts    # 24 个单元测试
├─ prisma/
│  ├─ schema.prisma              # User / Session 模型
│  └─ migrations/20261008072457_init/
├─ prisma.config.ts              # Prisma 7 连接串配置
├─ .github/workflows/ci.yml      # typecheck → migrate → test → build
├─ pnpm-workspace.yaml           # workspace 定义 + onlyBuiltDependencies
└─ tsconfig.base.json            # 统一严格模式
```

---

## 5. 调研结论存档（含来源）

### 5.1 部署与成本（调研 #1，2026-10-08）

| 结论 | 要点 |
|---|---|
| Supabase 免费版 | 500MB 库 / 1GB 存储 / 5GB 出口 / 5 万 MAU；**7 天不活跃即暂停**；**无自动备份**；Pro $25/月起 |
| Cloudflare Pages | 静态资源请求免费不限量；Functions 计入 Workers 免费版 10 万请求/天；`*.pages.dev` 大陆不稳 |
| Vercel | 官方 KB 承认大陆"可能加载缓慢或失败" → 本项目不采用 |
| GitHub 学生包 | Azure $100、Namecheap `.me` 域名 1 年；**DigitalOcean 已于 2026-07-31 退出** |
| 国内替代 | CloudBase ¥19.9/月（限时价）；uniCloud ¥5/月但免费空间月月需续、有小时级最低消费；LeanCloud 商用版 ≈¥900/月，直接出局 |

### 5.2 备案与大陆访问（调研 #3，2026-10-08）

| 结论 | 要点 |
|---|---|
| 境外免 ICP 备案 | 阿里云官方 FAQ 明文：解析指向境外服务器（如中国香港）**无需 ICP 备案** |
| **公安联网备案** | 依《计算机信息网络国际联网安全保护管理办法》，**服务器在境外但向大陆提供服务**须在开通起 **30 日内**办理；个人可扫码实名，审核约 2–3 天；备案号须展示在网页底部 |
| 个人 ICP 备案 | 论坛型交互站点已无法办理（BBS 前置审批停止）；交互式服务存在审核障碍 |
| 香港延迟 | 普通线路 80–200ms（晚高峰抖动）；CN2 GIA 20–50ms 但贵 1.5–3 倍 → **普通线路够用** |
| 微信风险 | 有公开案例称未备案域名可能被腾讯网址安全拦截；**非官方明文规则**，但应预防 → 让家人"用浏览器打开" |

### 5.3 命名调研

| 结论 | 要点 |
|---|---|
| 拉丁语核实 | `liber rationum` 语义成立，但确切短语主要见于 16–17 世纪法律文献，**不是古典拉丁常用表达**；古罗马用 `codex accepti et expensi`、`tabulae`、`adversaria` |
| `liber` 双关 | 成立，但是**同形异音**：书（短 i `lĭber`）/ 自由（长 i `līber`）/ 孩子（`liberi`） |
| 已排除 | **Liberum**（撞英国投行 Panmure Liberum + 五后缀域名全占）、**Libri**（英国软件类商标 UK00901306877）、**Rationum**（商店已有同名记账 App）、**Libero**（Microchip Libero SoC）、**Ratio**（已有记账 App） |
| 选定 | **Libellum**（`libellum.app` 未注册，无金融类撞名） |
| 用户名 | 探测 98 个候选，仅 9 个空闲 → 用户选定 **naeor** |

---

## 6. 已修复的问题

| 时间 | 问题 | 根因 | 解决 |
|---|---|---|---|
| 约 13:05–13:10 | Word 预览右侧被截断 | 预览管线在本机 Windows 150% 缩放下按 **144dpi** 出图，却按 96dpi 裁切（文档本身无误，经 5cm 标尺实测确认） | 改用 **DOCX→PDF→位图** 通道做版面校验；此后 27/14 页均判定零溢出 |
| 约 13:12 | Word 里出现原始 Markdown 链接语法 `[文字](网址)` | `md2docx.py` 未支持链接语法 | 扩展行内解析器，渲染为"文字（网址）"（小号灰字） |
| 约 13:22 | 命名探测结论失真 | 误把"GitHub 用户名空闲"当硬指标 | 改为以"域名可用 + 无同名产品"为主标准，首轮 30/30 TAKEN 的结论随之作废 |
| 约 13:21 | 文档内 7 处残留表述与新范围矛盾 | 范围从"共享账本"改为"独立账本"后未同步 | grep 全量排查并逐处修正 |
| 约 14:16 | 密钥可能被误提交 | `.env` 存在于项目根目录 | `.gitignore` 显式排除 + `git check-ignore` 与 `git add --dry-run` 双重验证 |
| 约 15:16 | **`npm` 在 PowerShell 中直接敲会失败** | PowerShell 执行策略禁止运行 `npm.ps1`（本机未设置任何执行策略，默认受限） | 统一改用 **`npm.cmd`**；后续 README 的 Windows 说明必须注明这一点，否则使用者会踩同样的坑 |
| 约 15:25 | **`prisma` 装到了 8.0.0-rc** | npm registry 上 `prisma` 的 `latest` 标签当前指向 `8.0.0-rc.21`（`prev` 才是 7.10.0），而 `@prisma/client` 是 7.10.0 → CLI 与 client 大版本不一致，必然出问题 | 用 `-E` 精确钉到 `prisma@7.10.0` 与 client 对齐；提交信息中注明原因，避免后人 `pnpm update` 又跳回 RC |
| 约 15:25 | **Prisma 7 不再支持 datasource 里的 `url`** | Prisma 7 把连接串移到 `prisma.config.ts`，并且**客户端必须传驱动适配器**，`new PrismaClient()` 会直接报错 | 按官方 v7 文档改造：新建 `prisma.config.ts`（`defineConfig` + `import "dotenv/config"`），安装 `@prisma/adapter-pg` + `pg`，客户端改为 `new PrismaClient({ adapter })` |
| 约 15:25 | pnpm-workspace.yaml 用中文写注释 | YAML 注释含中文在 Windows 下存在编码歧义风险（`Get-Content` 已出现乱码） | 注释全部改为英文，避免工具链解析差异 |
| 约 15:26 | **Vite 只监听 `::1`** | Vite 8 默认 `host: "localhost"` 在本机解析为 IPv6 回环，导致 `http://127.0.0.1:5173` 连不上（`netstat` 显示仅 `::1:5173`） | 在 `vite.config.ts` 显式设置 `server.host = "127.0.0.1"` |
| 约 15:28 | 临时日志文件混入待提交列表 | 诊断 Vite 时生成的 `_web.err` / `_web.log` 未被 `.gitignore` 覆盖（当时只有 `*.log`，没有 `*.err`） | 删除文件，并在 `.gitignore` 补 `*.err` |

---

## 7. 临时产物与清理记录

| 时间 | 清理内容 | 原因 |
|---|---|---|
| 约 13:12 | 删除 `_smoketest.*`、`_smoke_preview*`、`_probe/`、`_valid_preview/`、`_probe_docgrid.py`、`_qa.py`、各类 `_checks.json` | 版面排查过程的临时文件 |
| 13:15:51 | 删除旧项目目录 `pocket-ledger/` | 已迁移到 `Desktop\工作\记账程序`，哈希校验一致后删除 |
| 约 14:13 | 删除 v1 的 `PocketLedger-技术方案.docx/pdf` | 项目更名为 Libellum，旧文件作废 |
| 每次渲染后 | 删除 `docs/_pv_*/`、`docs/_c*.json` | 版面预览与检查产物，已加入 `.gitignore` |

---

## 8. 待办与下一步

| 优先级 | 事项 | 状态 |
|---|---|---|
| 1 | 建 GitHub 公开仓库 `naeor/libellum` 并推送 | ✅ 15:11 —— <https://github.com/naeor/libellum>（公开） |
| 2 | S0 收尾：初始化 pnpm workspace | ✅ 15:20 —— pnpm 12.10.1 免提权安装，无弹窗 |
| 3 | S1 骨架：workspace + Fastify health + Prisma 迁移 + CI | ✅ 15:27 —— 提交 `326bf3e`；28 个测试全过、端到端验证通过 |
| 4 | **S2 账号系统**：argon2id 密码哈希、邀请码注册、登录 / 退出 / 改密、服务端会话 Cookie、登录限流、前端登录注册页 | ⏳ 下一步 —— 🟢 全自动（结束时需你点一遍验收） |
| 5 | 注册域名 `libellum.app` | S7 前 —— 🔴 **需你付款** |
| 6 | 购买腾讯云香港轻量 2核2G（¥54/月 那款） | S7 前 —— 🔴 **需你付款** |
| 7 | 上线后 30 天内办理公安联网备案 | S7 验收项 —— 🔴 **需你实名 + APP 扫码** |

---

## 9. 维护方式

- 每一轮开发结束后追加一节**当天时间线**，格式与本文一致（时间 / 类型 / 改了什么 / 为什么 / 验证）。
- 涉及决策的变更同时写入第 2 章 ADR 表。
- 环境或依赖变更写入第 3 章。
- **新建文件必须登记进第 4 章文件清单**（S1 之后改为按目录树登记）。
- 生成的 Word/PDF 版仅作阅读用，**以本 Markdown 为准**。

---

## 10. 附录：GitHub 设备码授权到底做了什么

（于 2026-10-08 15:11:38 完成；项目所有者事后询问，特此记录）

**为什么需要授权**：`gh`（GitHub CLI）和 `git push` 都要代表你的账号向 GitHub 写数据。GitHub 不接受匿名写入，所以必须有一次"证明你是 naeor"的动作。

**那一步具体发生了什么**

1. 我在本机运行 `gh auth login --web`，CLI 向 GitHub 申请一个**一次性设备码**（形如 `793A-62EF`），并给出地址 `https://github.com/login/device`。
2. 你在浏览器打开该地址、登录自己的 GitHub 账号、输入这个码，再点"授权"。
3. GitHub 确认后，把一个 **OAuth token** 发回本机 CLI；CLI 把它存进 **Windows 凭据管理器（keyring）**。
4. 此后所有 `git push` 与 `gh` 命令都用这个 token 证明身份，**不必再输密码或验证码**。

**授权范围（判断风险的关键）**：`gh auth status` 显示 token 权限为 `repo`、`gist`、`read:org`。

| 权限 | 含义 |
|---|---|
| `repo` | 可读写你**所有**仓库的代码与设置（不只 libellum） |
| `gist` | 可读写你的代码片段 |
| `read:org` | 可读取你所属组织的成员信息 |

**需要知道的三件事**

1. 这个 token **只存在你这台电脑上**：不在聊天记录里，也没进 Git 仓库。
2. 它**不等于你的 GitHub 密码**：不能用来登录网页、改密码、改邮箱。你可以随时在 GitHub 的 `Settings → Applications` 里撤销。
3. **撤销后**：我这边再 `git push` 会重新要求授权（再走一次设备码流程）。撤销安全且可逆。

**为什么没有用手动粘贴的个人访问令牌（PAT）**：PAT 会以明文出现在聊天记录和命令历史里。设备码方式把凭据直接交给系统凭据管理器，更安全也更省事。

**风险提示**：`repo` 权限覆盖你名下所有仓库，范围偏大。若日后想收紧，可改用只对单个仓库生效的 fine-grained token，或安装限定仓库范围的 GitHub App。对当前阶段（单人开发、公开仓库）风险可接受。
