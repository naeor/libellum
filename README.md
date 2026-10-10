# Libellum

**The free, open ledger.**

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
[![Status](https://img.shields.io/badge/status-in%20development-orange.svg)](#status)

> **Status: in development.** Accounts, recording, statistics and screenshot recognition are
> built and in daily use; export and import are next, and nothing is deployed publicly yet.
> The stage-by-stage position is in [ROADMAP.md](docs/ROADMAP.md).

Libellum is an open-source, self-hosted expense tracker for individuals and families. It aims to be
the kind of tool you can hand to a family member: fast on a phone, no ads, no tracking, no account
required with a third party — just your own server and your own data.

## What works today

| Area | State |
|---|---|
| Accounts | Username + password, invite-only registration, one-time recovery code (no email needed), one active session per account |
| Recording | Income and expenses, categories, payment methods, tags, multiple currencies per ledger, notes, exact time and time zone |
| Detail screen | Per-currency monthly totals, income/expense switch, day-grouped list, filters, soft delete with a 5-second undo |
| Statistics | Trend, category share, period comparison, year overview, calendar heatmap — all drawn as hand-written SVG |
| Screenshot recognition | Upload a payment screenshot, read the fields locally with OCR, confirm or correct, save. Images are never written to disk and never leave the server |
| Not built yet | Export / import (in progress), Chinese-English switch, light theme picker, public read-only demo account, offline writing |

## How data stays traceable

Anything that crosses the ledger's boundary carries a reference that says which way it went:

```
Out-20261010-153012-a3f9   left this book, minted when the export ran
In-20261010-153012-b7c2    arrived in it, minted when the import ran
```

Every row also records where it came from (`source_ref`) and which import brought it in
(`import_ref`), exports are logged as metadata only — never the rows, never the file — and imports
record how many rows arrived against how many were already present. The shape is enforced by
database CHECK constraints rather than by convention, so a reference that cannot be traced cannot
be written in the first place. Details in
[docs/S6-导出与导入-设计决定.md](docs/S6-导出与导入-设计决定.md).

## Tech stack

| Layer | Choice |
|---|---|
| Frontend | React 19 + TypeScript + Vite + Tailwind CSS + TanStack Query |
| Backend | Node.js + Fastify + TypeScript + Zod |
| Database | PostgreSQL 17 + Prisma (migrations in the repository) |
| OCR | Python sidecar, local inference (RapidOCR), stdin/stdout JSON, no network port |
| Deployment | Docker Compose + Caddy (automatic HTTPS) |
| CI | GitHub Actions: typecheck, migrate on a clean database, test, build |

## Project documents

| Document | What it covers |
|---|---|
| [docs/PLAN.md](docs/PLAN.md) | Technical plan: architecture, data model, API, security, deployment, cost |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Stage-by-stage build plan with acceptance criteria |
| [docs/DEVLOG.md](docs/DEVLOG.md) | Development log: every change, decision and its evidence |
| [docs/BACKLOG.md](docs/BACKLOG.md) | Deferred ideas, and the ones deliberately rejected |
| [docs/S6-导出与导入-设计决定.md](docs/S6-导出与导入-设计决定.md) | Export/import decisions, including the reference scheme above |

## Privacy

Libellum ships no analytics and no advertising SDKs. It does not sell data. The only data it holds is
what you enter yourself, on a server you control. Payment screenshots used for recognition are
decoded in memory, never written to disk, and never sent to a third-party service.

## License

Licensed under the **GNU Affero General Public License v3.0** — see [LICENSE](LICENSE).

In short: you may use, study, modify and share this software freely. But if you run a modified version
as a network service for others, you must publish your modified source too. That is deliberate: this
tool should stay free for its users, and nobody should be able to turn it into a closed service.

---

中文说明见 [README.zh-CN.md](README.zh-CN.md)。
