# Libellum

**免费的、开源的小账簿。**

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
[![Status](https://img.shields.io/badge/status-early%20development-orange.svg)](#当前状态)

> **当前状态：早期开发中。** 设计方案已完成，应用代码正在编写。
> 目前还不能部署使用——进度见 [ROADMAP.md](docs/ROADMAP.md)。

Libellum 是一个开源、可自托管的记账工具，面向个人与家庭。目标是做成那种可以放心交给家里长辈用的东西：
手机上打开就快、没有广告、不做追踪、不需要第三方账号——只有你自己的服务器和你自己的数据。

## 名字的来历

拉丁语 **`liber`** 同时是「书」和「自由」；它的指小词 **`libellus`** 意为「小书、簿子、日记账」。
一本免费的、开源的小账簿——名字就把项目说完了。

*（相关的说法 `liber rationum`（账目之书）确实成立，但它的用例主要出现在 16–17 世纪的法律拉丁语中，
并非古典拉丁的常用表达——所以我们不宣称「古罗马人就这么说」。）*

## v1 计划功能

- 用户名 + 密码账号，账号之间数据严格隔离
- **一个账号一本独立账本**；多人共享账本排入 v2，数据库结构已按可共享设计
- 记录收入与支出，支持分类、日期、备注
- 拍照上传小票
- 月度统计与图表
- 导出 CSV / XLSX
- 手机优先的网页界面，可添加到主屏幕
- 公开的**只读演示账号**，任何人可直接体验

## 技术栈

| 层次 | 选型 |
|---|---|
| 前端 | React + TypeScript + Vite + Tailwind CSS |
| 后端 | Node.js + Fastify + TypeScript |
| 数据库 | PostgreSQL |
| ORM / 迁移 | Prisma |
| 部署 | Docker Compose + Caddy（自动 HTTPS） |
| CI | GitHub Actions |

## 项目文档

| 文档 | 内容 |
|---|---|
| [docs/PLAN.md](docs/PLAN.md) | 技术方案：架构、数据模型、API、安全、部署与成本 |
| [docs/ROADMAP.md](docs/ROADMAP.md) | 分阶段制作计划与验收标准 |
| [docs/DEVLOG.md](docs/DEVLOG.md) | 开发日志：每一次改动、决策及其验证依据 |

## 隐私

Libellum 不包含任何统计或广告 SDK，不出售数据。它保存的唯一数据就是你自己在**你自己的服务器**上录入的内容。

## 开源协议

采用 **GNU Affero 通用公共许可证 v3.0**——见 [LICENSE](LICENSE)。

简单说：你可以自由使用、研究、修改和分发本软件；但如果你把修改版作为网络服务提供给他人使用，
你也必须公开你的修改版源码。这是刻意的选择：这个工具应当对使用者保持免费，没人能把它变成闭源服务来卖。

---

English version: [README.md](README.md)
