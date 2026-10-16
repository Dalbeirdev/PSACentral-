# Module 10 Completion Report — First Milestone: Two Client Appliances on One Containerized Control Plane

**Date:** 2026-10-14 · **Environment:** Windows 11, Docker Engine 29.1.3 + Compose 2.40.3 (WSL), Go 1.25, Node 24.14, PostgreSQL 17, Microsoft Edge (E2E)

## Implementation status: **Complete** (Module 10 scope)

**Test evidence: 442 / 442 passed** across the full suite rerun on the final code — edge Go 24 (go vet clean), contracts 33, API 254 (19 files; unit 80 + integration 174 including the two real-Docker suites), web unit 28, Playwright E2E 95, fleet load test 1 (1,000 simulated agents), milestone 7 (two real appliances on the containerized Control Plane). `pnpm typecheck` clean for all three packages. Two product defects found by the new tests were fixed before this evidence was taken (issues 2, 7, 8).

**What works now:**
- **The Control Plane runs in Docker**: `psacc/control-plane-api` (API, agent gateway, migrations, bootstrap) and `psacc/control-plane-web` (Next.js standalone) with their own PostgreSQL in `infra/control-plane/compose.yaml` — non-root, read-only containers, every capability dropped, web and API published on loopback only, the mTLS gateway on the host address. `pnpm cp:setup → cp:build → cp:up → cp:bootstrap` brings up a working Control Plane with its first administrator in minutes; no synthetic data is involved.
- **First milestone demonstrated on that stack** (`pnpm test:milestone`): Test Client A (Autotask; Help Desk + Endpoint Management) and Test Client B (ConnectWise; Help Desk + Security Monitoring) onboarded through the wizard API, their packages installed as two appliances with independent PostgreSQL databases, both **verified, healthy and inventoried (13 tables each, with schema details)** on one dashboard.
- Milestone scenarios, all asserted against real containers: isolation; data boundary (a marked ticket on appliance A never appears in a full dump of the Control Plane database, while its count does); invalid token / identity / missing certificate refused; database stop → critical → recovery; restart persistence; **Control Plane outage with buffered reports and backfilled history**; **backup and restore** of the Control Plane per runbook.
- **Fleet scale** (`pnpm test:load`): 1,000 simulated agents enrolled through the real package/token/CSR flow (p95 812 ms, 36/s) and ran three heartbeat + full-report cycles at ≈180 requests/s with **0 failed requests**; heartbeat p95 402–423 ms, reports p95 298–324 ms, the fleet-wide sweep 4.6–5.2 s (budget 20 s of its 30 s period), fleet health query 52–62 ms and Database Explorer query 45–54 ms with 1,000 rows, all 1,000 healthy after every cycle. The first run of this test found and fixed a real contention bug (issue 7).
- Runbooks (`docs/RUNBOOKS.md`): Control Plane backup/restore (executed in the milestone), appliance backup/restore, air-gapped image export (`pnpm edge:export`), certificate incidents, upgrade and hardening.

**Honest limits:**

| Area | Status |
|---|---|
| TLS for the web origin | The stack publishes web and API on loopback; a TLS reverse proxy in front is required beyond a workstation (documented, not shipped). The agent gateway terminates its own mTLS. |
| Registry / signing | Images are built locally; `EDGE_IMAGE_DIGEST` pinning and cosign signatures need a registry (backlog OPS-REGISTRY). `pnpm edge:export` with checksum and image-ID verification is the interim integrity control. |
| Load test scope | One in-process API against one PostgreSQL on a developer workstation; it shows the gateway, sweep and queries keep up at 1,000 agents, not a production capacity plan. |
| PSA calls | Still none (Module 11): the milestone proves the platform and the data boundary, not PSA traffic. |

---

## Deliverables

| Part | Implementation |
|---|---|
| API image | `apps/api/Dockerfile`: `node:24-alpine`, `pnpm install --frozen-lockfile`, build, `pnpm deploy --prod`; runs as `node`; `HEALTHCHECK` on `/api/v1/health/live`. `package.json` `files` ships `dist`, `migrations`, `templates`. |
| Web image | `apps/web/Dockerfile`: Next.js `output: 'standalone'` (enabled only by `NEXT_OUTPUT=standalone`, so `next start` stays the default); `/api` rewrite compiled to `http://api:4210`. |
| Compose stack | `infra/control-plane/compose.yaml` (`psacc-cp`): postgres (init script creates `psacc_owner`, `psacc_app_rw`, `psacc_app NOBYPASSRLS`), migrate (owner login, exits), api (`TRUST_PROXY=uniquelocal`, gateway `0.0.0.0:8643`), web (`127.0.0.1:3410`). Hardened: `read_only`, `cap_drop: ALL`, `no-new-privileges`, tmpfs, log rotation. |
| Bootstrap | `cli.js bootstrap` (`apps/api/src/database/bootstrap.ts`): first organization + Super Administrator from `BOOTSTRAP_*`; password from env or `_FILE`, policy-checked, never printed; idempotent; audited `organization.bootstrapped`. |
| Operations script | `scripts/control-plane.mjs`: `setup` (random secrets, gateway address detected), `build` (context staged without `node_modules`), `up/down/destroy/status/logs/psql`, `bootstrap`, `backup` (`pg_dump -Fc` + SHA-256), `restore` (checksum → stop → recreate DB with the install grants → `pg_restore` → migrate → start). |
| Image export | `scripts/edge.mjs export`: `docker save` archive + `.sha256` + `.image-id` for air-gapped installs. |
| Milestone test | `apps/api/test/milestone/milestone.test.ts` (`vitest.milestone.config.ts`), writes `docs/reports/module-10/milestone-results.json`; `MILESTONE_KEEP=1` leaves the stack for the screenshot script. |
| Load test | `apps/api/test/load/fleet-load.test.ts` (`vitest.load.config.ts`), writes `load-test.json`. |
| Docs | `docs/RUNBOOKS.md` (new), `ARCHITECTURE.md` §4.9, `ENVIRONMENTS.md` (containerized stack), README scripts. |

## Milestone acceptance — executed results

Final run: `pnpm test:milestone` against the final images (`psacc/control-plane-api:0.1.0`, `psacc/control-plane-web:0.1.0`, `psacc/psa-edge:0.1.0`), **7/7 passed in 251 s** — `module-10/milestone-vitest.txt`, machine-readable `module-10/milestone-results.json`. The same seven scenarios had passed earlier the same day with `MILESTONE_KEEP=1` (231 s) on images that lacked only the pool error listener of issue 8; that run produced `module-10/milestone-containers.txt` (`docker ps` / `docker volume ls` with everything up) and the screenshots in `module-10/screenshots/`.

| # | Milestone check | Result | Evidence |
|---|---|---|---|
| 1 | Control Plane containers up, migrated, bootstrapped; administrator signed in through the web proxy | **Pass** (27 s) | `psacc-cp-postgres`, `-migrate`, `-api`, `-web` healthy; `organization.bootstrapped` audit |
| 2 | Two appliances installed from generated packages, enrolled, verified and inventoried | **Pass** (60 s) | DEP-00001 (Test Client A, Autotask; Help Desk + Endpoint Management), DEP-00002 (Test Client B, ConnectWise; Help Desk + Security Monitoring) — 13 tables each with schema details on the dashboard |
| 3 | Isolation: two clients, two PSA providers, own PostgreSQL container, volume, identity and credentials each | **Pass** | distinct `installation.id`, distinct `app_db_password` secrets, `psacc-dep-0000N_pgdata` volumes, separate compose networks |
| 4 | Data boundary: ticket text written on appliance A is absent from a full `pg_dump --data-only` of the Control Plane; only the count (1) is reported | **Pass** | dump 152,757 bytes scanned for the marker |
| 5 | Invalid token / identity: replayed used token, token of another deployment, fabricated token, request without certificate | **Pass** | `token-used`, `token-used`, `invalid-token`; TLS handshake refused without a client certificate |
| 6 | Database stop on appliance B → `critical` (`database_unavailable`) from the agent's real checks → start → `healthy` | **Pass** (30 s) | timeline healthy → critical → healthy |
| 7 | Restart persistence (`compose down` / `up`): same certificate serial, ticket row survived, healthy again | **Pass** (28 s) | serial unchanged |
| 8 | Control Plane outage (API stopped 52 s): appliance local admin still served, reports buffered (3), history backfilled after recovery | **Pass** (71 s) | 3 backfilled host-resource samples in the window |
| 9 | Backup and restore per runbook: checksum verified, database recreated, a client created after the backup is gone, both appliances healthy | **Pass** (25 s) | `infra/control-plane/backups/psacc-20261015T003907Z.dump` (ignored by git) |

Isolation detail observed in `milestone-containers.txt`: 3 Control Plane containers + 5 running per appliance (postgres, api, worker, agent, backup; migrate exits after running) and 1 + 4 × 2 named volumes, nothing shared between the two appliances.

## Fleet-scale load test — executed results

Run: `pnpm test:load` (in-process API on the workstation against PostgreSQL 17 in WSL Docker; `LOAD_AGENTS=1000`, `LOAD_CYCLES=3`, `LOAD_CONCURRENCY=50`), 75.5 s, **passed** — raw data in `module-10/load-test.json`.

| Phase | Count | p50 | p95 | p99 | max | Notes |
|---|---|---|---|---|---|---|
| Enrollment (package → token → CSR → certificate) | 1,000 | 530 ms | 812 ms | 976 ms | 1,251 ms | 28.1 s total, 36/s, 0 failures, 0 retries |
| Cycle 1 heartbeat | 1,000 | 309 ms | 416 ms | 507 ms | 532 ms | 182 req/s over the cycle |
| Cycle 1 reports (host, services, database, backup, certificate…) | 1,000 | 229 ms | 324 ms | 391 ms | 425 ms | |
| Cycle 2 heartbeat | 1,000 | 322 ms | 423 ms | 459 ms | 523 ms | 181 req/s |
| Cycle 2 reports | 1,000 | 231 ms | 316 ms | 384 ms | 395 ms | |
| Cycle 3 heartbeat | 1,000 | 311 ms | 402 ms | 434 ms | 459 ms | 191 req/s |
| Cycle 3 reports | 1,000 | 213 ms | 298 ms | 358 ms | 394 ms | |

| Per cycle | Sweep (1,000 deployments) | Fleet query | Database Explorer query | Healthy after sweep |
|---|---|---|---|---|
| 1 | 5,218 ms | 52 ms | 45 ms | 1,000 / 1,000 |
| 2 | 4,577 ms | 62 ms | 54 ms | 1,000 / 1,000 |
| 3 | 4,816 ms | 55 ms | 46 ms | 1,000 / 1,000 |

Thresholds asserted by the test: no failed requests, heartbeat p95 < 1,000 ms, reports p95 < 2,000 ms, sweep < 20 s, fleet query < 5 s, every agent healthy after each cycle.

Storage (metadata only, after 3 cycles): database 87.8 MB; ≈5.0 KB of report history per agent per cycle, ≈7.3 MB per agent per day at a 60-second cycle before the 30-day retention prunes it (`deployment_reports` 15.1 MB / 26,847 rows, `deployment_report_latest` 6.6 MB / 9,486 rows, `agent_certificates` 0.8 MB / 1,000 rows).

Before the fix in issue 7 the same run measured heartbeat p95 1,729 ms (cycle 1) and p99 3,394 ms (cycle 2) — the sweep's single transaction blocking the gateway — and failed the threshold; those numbers are kept here because they are what the test was for.

## Testing — executed results

Raw output in [`module-10/`](module-10): `milestone-vitest.txt` + `milestone-results.json`, `load-vitest.txt` + `load-test.json`, `edge-go-test.txt`, `api-vitest.txt` (both real-Docker suites), `contracts-vitest.txt`, `web-vitest.txt`, `e2e-playwright.txt`, `typecheck.txt`, `milestone-containers.txt` (docker ps / volumes with the stack and both appliances up). Screenshots from the containerized Control Plane with both appliances live are in [`module-10/screenshots/`](module-10/screenshots). The evidence files were scanned for secrets and enrollment tokens; none were found.

| Suite | Command | Result | Evidence |
|---|---|---|---|
| Edge agent (Go 1.25, in Docker) | `go vet ./... && go test -cover ./...` | **24 passed** (`internal/agent`, `api`, `inventory`, `secretbox`, …) | `edge-go-test.txt` |
| Typecheck | `pnpm typecheck` | **clean** (contracts, api, web) | `typecheck.txt` |
| Contracts (Vitest) | `packages/contracts` | **33 passed** (5 files) | `contracts-vitest.txt` |
| API (Vitest unit + integration) | `apps/api` | **254 passed** (19 files) incl. `edge-docker.test.ts` (two real appliances: enrolment over mTLS, inventory, schema, restart, outage) and `agent-docker.test.ts`; new `database-pool.test.ts` | `api-vitest.txt` |
| Web unit (Vitest) | `apps/web` | **28 passed** (4 files) | `web-vitest.txt` |
| Browser E2E (Playwright, Edge, production build) | `apps/web` | **95 passed** in 3.6 min — a11y (axe), auth/MFA, clients + wizard, dashboard, database explorer, deployments, enrollment, monitoring, PSA, responsive | `e2e-playwright.txt` |
| Fleet load | `pnpm test:load` | **1 passed** (1,000 agents; tables above) | `load-vitest.txt`, `load-test.json` |
| Milestone | `pnpm test:milestone` | **7 passed** (231 s; table above) | `milestone-vitest.txt`, `milestone-results.json`, `milestone-containers.txt`, screenshots |

Docker was available: nothing in this module is marked BLOCKED. After the final run no `psacc-dep-*` or `psacc-cp*` containers, volumes or networks remain on the shared engine; the other stacks on it were never touched.

## Issues found and resolved

| # | Issue | Cause | Resolution |
|---|---|---|---|
| 1 | Web image build failed type-checking | `playwright.config.ts` imports `./e2e/env`, which the build context excludes | The Playwright config is excluded from the context as well |
| 2 | **Load test: the gateway returned 429 to a fleet sharing one address** (all 1,000 simulated agents came from 127.0.0.1) | Every gateway route was rate limited per source address (600/min) — a real problem for appliances behind one NAT address | Authenticated routes (heartbeat, reports, renew) are now limited per certificate identity (120/min each); the per-address limit stays for enrollment and for requests without a certificate; hit table pruned. Gateway test added (two identities from one address; anonymous requests still limited) |
| 3 | Web image build: npm registry fetches of `next` / `@next/swc` timed out through the daemon's network | Large tarballs, default fetch timeout | Lower network concurrency and longer fetch timeouts/retries in the web Dockerfile; builds succeed |
| 4 | Web image: `apps/web/public` does not exist | No static assets yet; the runtime stage copies the directory regardless | The build stage creates it (separate layer, keeps the install cached) |
| 5 | Milestone test-side mistakes | `tokenValidityHours` must be 1/4/24/72; the appliance metadata key is `installation.id` and the secret file `app_db_password`; the volume is `<project>_pgdata`; a path with spaces was split into arguments; backfilled samples are polled rather than read instantly after reconnection | Fixed in the test; each scenario asserts the real values |
| 7 | **Load test: heartbeat p95 of 1.7 s in the first cycle, p99 of 3.4 s in the second** (threshold 1 s) | The 30-second health sweep evaluated the whole fleet inside one transaction, holding row locks on `deployments` for its full duration (≈3.4 s at 1,000 agents); every heartbeat and report arriving meanwhile queued behind it | `HealthService.sweep()` now evaluates each deployment in its own short transaction and runs retention separately; a failed evaluation is logged and the sweep continues. Health integration tests (7) and the load test rerun confirm the fix |
| 8 | **The API process exited when PostgreSQL closed its idle connections** (seen during the evidence run: the E2E API server died with `terminating connection due to administrator command` when the WSL Docker daemon restarted underneath it) | `pg.Pool` reports a server-closed idle connection as an `error` event; without a listener Node treats it as unhandled and exits the process | `createPool()` now attaches a listener that logs a warning (no secrets) and lets the pool replace the connection; unit test `database-pool.test.ts` emits the event and asserts the process survives and the log carries no password. The compose stack would also restart the container, but the API no longer depends on that |
| 9 | Evidence run interrupted by the workstation's WSL instance: the distro (and with it the Docker daemon and every stack in it) shut down one to four minutes after the last WSL session closed, so the API suite found no database and the E2E API server lost its connections | Environment, not product: the host's `.wslconfig` keeps the VM alive (`vmIdleTimeout`) but the Ubuntu instance still terminated when idle after the overnight wake; `journalctl` shows repeated `docker.service` stop/start cycles with `daemonShuttingDown=true` | A background WSL session was kept open for the reruns; the API suite, E2E and milestone were rerun with the daemon stable. Recorded in `ENVIRONMENTS.md`; the operator should keep a WSL session open or configure the instance idle timeout |
| 6 | Load test harness | Package rate limit (30/min per user) and the suspended seeded client tripped enrollments; the test's own PostgreSQL connections were reset under churn | Limits raised for the test process only; only active clients are targeted; enrollment is API-only; transient connection errors are retried and counted |

## Outstanding

- OPS-REGISTRY: private registry, cosign signatures, digest pinning for both the edge and Control Plane images.
- TLS termination for the web origin in staging/production (reverse proxy); OIDC (SEC-OIDC) and KMS-backed keys (SEC-KMS) before production.
- Module 4 (Service Catalog UI) per the approved order, then Modules 11–15.

## Next module

Per the approved order (5 → 6 → 7 → 8 → 9 → 10, then 4): **Module 4 — Service Catalog**: database-driven catalog management pages (create, edit, activate/deactivate services; categories; default services; configuration requirements; integration dependencies; assignment to clients reflected in deployment configuration). Alternatively Module 11 (PSA connection testing from the appliance) if the PSA path is the priority.
