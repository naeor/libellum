# Libellum

**The free, open ledger.**

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
[![Status](https://img.shields.io/badge/status-early%20development-orange.svg)](#status)

> **Status: early development.** The design is finished and the application code is being built.
> Nothing is deployable yet — see [ROADMAP.md](docs/ROADMAP.md) for the current stage.

Libellum is an open-source, self-hosted expense tracker for individuals and families. It aims to be
the kind of tool you can hand to a family member: fast on a phone, no ads, no tracking, no account
required with a third party — just your own server and your own data.

## Why the name

In Latin, **`liber`** means both *"book"* and *"free"*. Its diminutive **`libellus`** means *"a little
book, a notebook, a daybook"*. A free, open little ledger — the name says what the project is.

*(The related phrase `liber rationum`, "book of accounts", is real, but it is attested mainly in
16th–17th century legal Latin rather than classical usage — so we do not claim the Romans said it.)*

## Planned features (v1)

- Username + password accounts, with strict per-account data isolation
- **One ledger per account** — shared ledgers are planned for v2, and the schema is already designed for it
- Record income and expenses with category, date and note
- Receipt photos
- Monthly statistics and charts
- CSV / XLSX export
- Mobile-first web UI, installable to the home screen
- A public **read-only demo account** for anyone who wants to try it

## Tech stack

| Layer | Choice |
|---|---|
| Frontend | React + TypeScript + Vite + Tailwind CSS |
| Backend | Node.js + Fastify + TypeScript |
| Database | PostgreSQL |
| ORM / migrations | Prisma |
| Deployment | Docker Compose + Caddy (automatic HTTPS) |
| CI | GitHub Actions |

## Project documents

| Document | What it covers |
|---|---|
| [docs/PLAN.md](docs/PLAN.md) | Technical plan: architecture, data model, API, security, deployment, cost |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Stage-by-stage build plan with acceptance criteria |
| [docs/DEVLOG.md](docs/DEVLOG.md) | Development log: every change, decision and its evidence |

## Privacy

Libellum ships no analytics and no advertising SDKs. It does not sell data. The only data it holds is
what you enter yourself, on a server you control.

## License

Licensed under the **GNU Affero General Public License v3.0** — see [LICENSE](LICENSE).

In short: you may use, study, modify and share this software freely. But if you run a modified version
as a network service for others, you must publish your modified source too. That is deliberate: this
tool should stay free for its users, and nobody should be able to turn it into a closed service.

---

中文说明见 [README.zh-CN.md](README.zh-CN.md)。
