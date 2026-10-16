# PSA Control Center

Central Control Plane for onboarding clients, configuring their PSA (Autotask, ConnectWise PSA, HaloPSA, …), generating per-client Docker deployment packages, and monitoring each client's isolated **PSA Edge Appliance**.

> **Build status: Modules 1–15 of the master specification delivered, plus Module 16 (license enforcement on the appliance)** (foundation, authentication, dashboard; client management and the onboarding wizard; PSA provider adapters and instance management; service catalog administration; deployment records and package generation; the PSA Edge appliance and its database; agent enrollment over mutual TLS; live health monitoring from agent reports; the Database Explorer on the agent's catalog inspection; the containerized Control Plane and the first-milestone acceptance with two client appliances; real PSA connection tests run on the appliance and reported as metadata; ticket synchronization on the appliance as the system of record, with counts and statuses reported centrally; signed remote commands pulled by the agent — refresh, PSA test, sync, restart, certificate rotation and staged image upgrades applied on the host; licenses per client with expiry and deployment limits, and reversible deployment suspension; secure decommissioning that retires the identity on the Control Plane, host-side uninstall scripts, a retention policy with purge, and explicit removal of records; offline-verifiable license tokens pinned to the edge image that stop PSA work without a valid license). See [`docs/MODULE_PLAN.md`](docs/MODULE_PLAN.md) and the completion reports [`MODULE-01`](docs/reports/MODULE-01.md), [`MODULE-02`](docs/reports/MODULE-02.md), [`MODULE-03`](docs/reports/MODULE-03.md), [`MODULE-04`](docs/reports/MODULE-04.md), [`MODULE-05`](docs/reports/MODULE-05.md), [`MODULE-06`](docs/reports/MODULE-06.md), [`MODULE-07`](docs/reports/MODULE-07.md), [`MODULE-08`](docs/reports/MODULE-08.md), [`MODULE-09`](docs/reports/MODULE-09.md), [`MODULE-10`](docs/reports/MODULE-10.md), [`MODULE-11`](docs/reports/MODULE-11.md), [`MODULE-12`](docs/reports/MODULE-12.md), [`MODULE-13`](docs/reports/MODULE-13.md), [`MODULE-14`](docs/reports/MODULE-14.md), [`MODULE-15`](docs/reports/MODULE-15.md), [`MODULE-16`](docs/reports/MODULE-16.md). Sections of the UI for later modules are visible but clearly marked *Planned* and have no working controls.

| | |
|---|---|
| Architecture & ERD | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) |
| UI / UX design (dashboard, onboarding, deployments, health, DB explorer) | [`docs/UI_DESIGN.md`](docs/UI_DESIGN.md) |
| Security architecture | [`docs/SECURITY.md`](docs/SECURITY.md) |
| Environments & secrets | [`docs/ENVIRONMENTS.md`](docs/ENVIRONMENTS.md) |
| Reuse of existing projects | [`docs/REUSE_ASSESSMENT.md`](docs/REUSE_ASSESSMENT.md) |

## Stack

| Layer | Technology |
|---|---|
| Web UI | Next.js 16 (App Router), React 19, TypeScript 6, Tailwind CSS 4, Recharts 3, Lucide |
| API | NestJS 12 (ESM), `pg`, zod 4 (shared contracts), OpenAPI 3 |
| Database | PostgreSQL 17 with row-level security per organization and client scope |
| Tests | Vitest (unit + integration on real PostgreSQL), Playwright + axe-core (E2E, accessibility, responsive) |
| Edge appliance | Go 1.25 (pgx), one static binary on distroless (`psacc/psa-edge`), Docker Compose, per-deployment PostgreSQL 17 |

## Prerequisites

- Node.js ≥ 24 and pnpm 11 (`corepack enable` or `npm i -g pnpm`)
- Docker Engine with Compose v2. Native Docker or **Docker inside WSL** both work: `scripts/db.mjs` detects which one is available. To pick a WSL distro, set `PSACC_WSL_DISTRO`.
- Microsoft Edge (preinstalled on Windows) for the E2E suite, or change `channel` in `apps/web/playwright.config.ts`.

## Getting started

```bash
pnpm install
```
```bash
pnpm setup
```
```bash
pnpm db:up
```
```bash
pnpm db:seed
```
```bash
pnpm dev
```

- `pnpm setup` generates `infra/dev/.env`, `apps/api/.env` and `apps/web/.env.local` with random secrets. Existing files are never overwritten, and no secret is printed.
- `pnpm db:up` starts `psacc-dev-postgres` on `127.0.0.1:55432`. On first start it creates the least-privilege roles and the `psacc_dev`, `psacc_test` and `psacc_e2e` databases.
- `pnpm db:seed` runs migrations and loads **synthetic** data: 1 organization, 8 users (one per role), 26 clients with 61 contacts and service assignments, 29 PSA instances, 27 deployments and a 30-day health history. Use `-- --reset` to rebuild it. Every row is flagged `is_synthetic`.
- `pnpm dev` serves the web app on http://localhost:3210 and the API on http://127.0.0.1:4210 (OpenAPI at `/api/docs`).

Synthetic sign-ins: `avery.admin@psacc.test` (Super Administrator), `jordan.ops@`, `morgan.tech@`, `riley.technician@` (sees 4 assigned clients), `casey.service@`, `sam.security@`, `taylor.audit@`, `quinn.viewer@` (all `@psacc.test`). The password is `SEED_DEFAULT_PASSWORD` in `apps/api/.env`.

## Database

| Command | What it does |
|---|---|
| `pnpm db:migrate` | Apply pending migrations (`apps/api/migrations`) as the schema owner. Idempotent; refuses if an applied migration file was modified. |
| `pnpm --filter @psacc/api db:status` | List migration state |
| `pnpm db:seed` | Migrate + seed synthetic data (skips if already seeded). Add `-- --reset` to rebuild the synthetic org. Refused outside development/test. |
| `pnpm db:psql` | psql shell inside the dev container |
| `pnpm db:down` | Stop the container (**data volume is kept**) |

New schema changes go in a new `NNNN_description.sql` file. Applied migrations are never edited.

## Testing

```bash
pnpm test
```
```bash
pnpm test:e2e
```
```bash
pnpm typecheck
```

- `pnpm test` runs the contracts, web and API unit tests, plus the API integration tests. Integration tests drop and rebuild `psacc_test` on every run.
- `pnpm test:e2e` builds the production web app, starts an isolated API on `:4310` against `psacc_e2e`, and runs Playwright on desktop (1440px) and mobile (375px). Every test also fails on any browser dialog, uncaught error or console error.

## Edge appliance (`apps/edge`)

Go is not required locally: these commands run in the official `golang:1.25-alpine` image.

| Command | What it does |
|---|---|
| `pnpm edge:test` | `go vet` and the Go unit tests |
| `pnpm edge:build` | Builds the standard image `psacc/psa-edge:<version>` (distroless, non-root). The build also runs vet and the tests. |
| `pnpm edge:tidy` | `go mod tidy` and `go mod verify` |
| `pnpm edge:export` | Writes `dist/edge/psa-edge-<version>.tar` (+ checksum, image ID) for air-gapped clients |
| `pnpm cp:setup` / `cp:build` / `cp:up` / `cp:down` / `cp:destroy` | Containerized Control Plane (`infra/control-plane`): generate secrets, build the API and web images, start / stop / remove the stack |
| `scripts/edge/Install-EdgePackage.ps1 -Zip <package.zip>` | Install a downloaded deployment package on a Windows machine whose Docker Engine runs inside WSL (no Docker Desktop); `-Status`, `-Stop`, `-Wipe` |
| `pnpm cp:bootstrap` | First organization and administrator (idempotent, audited) |
| `pnpm cp:backup` / `cp:restore <file>` | Control Plane database backup and restore (`docs/RUNBOOKS.md`) |
| `pnpm test:milestone` | First-milestone acceptance: two client appliances against the containerized Control Plane |
| `pnpm test:load` | Fleet-scale load test (1,000 simulated agents through the real enrollment flow) |

The API integration suite includes real-Docker tests:
- `package-docker`: Compose validation and each package's own database.
- `edge-docker`: two client appliances installed side by side with their own `install.sh`.

They need the image built locally. Without Docker or the image, they are skipped and reported as **BLOCKED**, never as passed.

## Backup & restore (local dev)

Backup and restore use the dev data volume `psacc-dev-pgdata`.

```bash
docker exec psacc-dev-postgres pg_dump -U postgres -Fc psacc_dev > psacc_dev.dump
```
```bash
docker exec -i psacc-dev-postgres pg_restore -U postgres -d psacc_dev --clean --if-exists < psacc_dev.dump
```

On Windows with WSL Docker, prefix the command with `wsl`. Production backup and restore runbooks are tracked as backlog item DOC-BACKUP.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `infra/dev/.env is missing` | Run `pnpm setup`. |
| API exits with `Invalid environment configuration` | Fix the listed variables. Staging/production refuse unsafe values on purpose; see `docs/ENVIRONMENTS.md`. |
| `ECONNREFUSED 127.0.0.1:55432` | Run `pnpm db:up`, then check `pnpm db:status`. With WSL, make sure the distro is running. |
| Sign-in says "Invalid email or password" for a seed user | Run `pnpm db:seed`, and use the password from `apps/api/.env`. After 5 failures the account locks for 15 minutes. |
| `429 Too many requests` | Wait 60 s (per-IP limits), or raise `LOGIN_RATE_LIMIT_PER_MINUTE` locally. |
| Readiness `/api/v1/health/ready` returns 503 | Pending migrations or DB down: run `pnpm db:migrate`. |
| Port 3210/4210/55432 busy | Another stack is using it. Change `PORT` / `--port` and `APP_ALLOWED_ORIGINS` to match. |

## Repository layout

```
apps/api        NestJS Control Plane API (+ migrations, tests)
apps/web        Next.js Control Plane UI (+ Playwright e2e)
packages/contracts  zod schemas, DTO types, permission/role catalog
infra/dev       local PostgreSQL (Docker Compose)
scripts         setup + database helpers
docs            architecture, design, security, plan, reports
```
