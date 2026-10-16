# Module 8 Completion Report — Live Health Monitoring

**Date:** 2026-10-14 · **Environment:** Windows 11, Docker Engine 29.1.3 + Compose 2.40.3 (WSL), Go 1.25, Node 24.14, PostgreSQL 17, Microsoft Edge (E2E)

## Implementation status: **Complete** (Module 8 scope)

**Tests: 411 executed, 411 passed, 0 failed, 0 skipped** — Go unit 20 · contracts 30 · API 248 (79 unit, 169 integration, of which **17 on the real Docker Engine**) · web unit 24 · E2E 89 (desktop and mobile). The real-Docker suite installs two client appliances (Autotask and ConnectWise) from generated packages, lets them enroll and report, and asserts the dashboard's evaluation from their measurements; the screenshots and `health-api-sample.json` come from a third live appliance installed against the development stack.

**What works now:**
- The agent measures and reports, over its mutual-TLS channel, every item in spec §13: agent online/offline, last heartbeat, agent and application versions, PostgreSQL availability, migration state, database size, table count, PSA connector status, service health, CPU, memory, disk, uptime and recent errors.
- The Control Plane **evaluates** each deployment with a rules engine against a centrally configured policy, into Healthy, Degraded, Critical, Offline or Unknown. **A heartbeat alone never counts as healthy.**
- A deployment becomes **Verified** on its first healthy evaluation from real reports.
- Pages: fleet health (`/monitoring`), per-deployment health, logs, and the health policy under Settings.
- On the real Docker engine, both client appliances (Autotask and ConnectWise) reported, were evaluated healthy and verified, turned critical when their database was stopped, and recovered after real checks.

**Honest limits:**

| Area | Status |
|---|---|
| Container states | The agent has no Docker socket, so service states are **probe results** (database ping, `edge-api` `/healthz`, worker and backup liveness timestamps), labelled as such on the page. |
| Host disk encryption | Cannot be confirmed from inside a container: reported as null and shown as such. |
| PSA and tickets | The connector reports its credential status and that it makes no API calls yet; ticket and sync counts are real but zero until Modules 11–12. |
| Fleet-scale load | Not tested (TEST-LOAD backlog). |

---

## Agent reports (edge → Control Plane)

| Report type | Measured by the agent | Used for |
|---|---|---|
| `database` | Inspector role: availability, server version, size, schema and migration version, table inventory (catalog estimates) | Critical/degraded rules; Database Explorer (Module 9) |
| `host_resources` | CPU from `/proc/stat` deltas; memory from the cgroup (`memory.current` / `memory.max`, else `/proc/meminfo`); disk by `statfs` on the volume file system; uptime; CPU count | Threshold rules, charts, usage bars |
| `containers` | Probes: `edge-postgres` (ping), `edge-api` (`/healthz`), `edge-worker` (liveness ≤ 3 min), `edge-backup` (last run), `edge-agent` (self) | Service health breakdown |
| `psa_integration_status` | Status, credential counts, last test, `apiCallsImplemented: false` | PSA connector status |
| `ticket_processing_metrics` | Counts only (no content) via `edge_health_status()` | Metrics |
| `synchronization` | Last run, counts, error code, and up to 10 **redacted** recent errors from `integration_logs` | Latest error details |
| `versions` | Agent, image, application, schema, PostgreSQL | Version display |
| `backup` | Last status, time, size, retention, last error | Backup rule |
| `certificates_security` | Certificate serial and expiry, local admin failed sign-ins and lock, encrypted disk (null) | Certificate rule |

- Every schema is **strict** (`packages/contracts/src/health.ts`): enums, numbers, versions, identifiers and messages of at most 200 characters. Unknown fields, free text where a code is expected, and timestamps outside a window are rejected per report and audited (`agent.report.rejected`) without the offending content.
- Delivery: the agent stores each collection as a batch in its outbox and delivers after each heartbeat. Rejected batches are dropped with a log line; batches that could not be sent stay for the next cycle (bounded at 50).
- New edge migration `0002_health_status.sql`: `edge_health_status()` and `edge_recent_errors()` are SECURITY DEFINER functions returning counts, statuses and redacted errors to the inspector role, which still has no table privileges.

## Control Plane

| Part | Implementation |
|---|---|
| Gateway | `POST /agent/v1/reports` (mTLS, 256 KB, up to 50 reports per batch). The heartbeat response carries the organization's heartbeat interval, so agents adapt to policy changes. |
| Storage (migration `0006`) | `deployment_reports` (30 days), `deployment_report_latest` (one row per deployment and type), `deployment_heartbeats` (7 days), `health_policies` (per organization), and `deployments.health_findings` / `health_evaluated_at`. All FORCE RLS with client scope. |
| Rules engine | `rules.ts`, pure and unit-tested. Offline → heartbeat age; Unknown → no database report; Critical → database unavailable, `edge-api`/`edge-postgres` down, critical resource thresholds, certificate expired; Degraded → stale reports, stale worker/backup, warning thresholds, old or failed backup, certificate expiring, PSA test failed, sync failed; Healthy otherwise. Findings carry a stable code, severity and message. |
| Evaluation triggers | Enrollment, every report batch, every heartbeat (recovery from offline), every policy change, and a 30-second sweep across organizations (`app_organizations_with_agents()`, which sets each organization's context because FORCE RLS applies to the owner). The sweep also prunes old reports and heartbeats. |
| State changes | `deployment_health_events` rows with source `agent` or `system`; the first healthy evaluation sets `verified_at`, lifecycle `verified`, and audits `deployment.verified`. |
| Policy | `GET/PUT /monitoring/policy` (`settings.manage` to change). Validated: critical above warning, offline at least two intervals. Changes are audited with a diff and applied to every live deployment immediately. |
| Views | `GET /monitoring/fleet` (states, counts with synthetic separated, latest resources and database availability, `live=1` filter) and `GET /deployments/:id/health` (findings, latest report per type, 24 h resource history, last 50 heartbeats, 30-day event timeline). |

## Frontend

| Route | What it does |
|---|---|
| `/monitoring` | Fleet health. Scorecards per state with **synthetic counted separately** and a "show live only" switch; search; per-row state, reason, heartbeat age, agent version, CPU/memory/disk usage bars against the policy, database availability and last report time; refresh. |
| `/deployments/[id]/health` | Scorecard with the evaluated state, reason, findings and agent/heartbeat/enrolled/verified facts; resource bars and a 24 h **Recharts** line chart with the warning line and a data table; database indicators; service checks ("via http/database/liveness"); PSA, backup, certificate and local-admin status; health timeline; recent heartbeats; latest errors. Synthetic records show the honest placeholder. |
| `/deployments/[id]/logs` | Sanitized agent errors, health state changes, and the deployment's audit events. |
| `/settings/health` | Full-page policy form with inline validation and "Reset to defaults"; visible only with `settings.manage`. |
| Elsewhere | Deployment overview shows the evaluated state and links to the health page; the client Health tab text is updated; Health Monitoring is no longer "Planned". |

Timestamps use the user's time zone; every page has a refresh control.

---

## Testing — executed results

Raw output in [`module-08/`](module-08): `edge-go-test.txt`, `api-vitest.txt` (including both real-Docker suites), `contracts-vitest.txt`, `web-vitest.txt`, `e2e-playwright.txt`, `typecheck.txt`. Real-appliance evidence: `health-api-sample.json` (the evaluated health of a live appliance, with the inventory omitted) and `agent-log-excerpt.txt`. Screenshots are in [`module-08/screenshots/`](module-08/screenshots). The evidence files were scanned for secrets and enrollment tokens; none were found.

| Suite | Files | Tests | Result |
|---|---|---|---|
| Go unit (`go vet` + `go test`, edge appliance) | 6 packages | 20 | ✅ |
| TypeScript typecheck (all workspaces) | — | — | ✅ 0 errors |
| Contracts (strict report schemas, policy) | 4 | 30 | ✅ |
| API unit (rules engine 7, security primitives, …) | 5 | 79 | ✅ |
| API integration (real PostgreSQL, rebuilt per run), including health (7), gateway (10) and the two real-Docker suites (12 + 5) | 12 | 169 | ✅ |
| Web unit | 3 | 24 | ✅ |
| E2E — Edge, production build with its own agent gateway, desktop 1440 px + mobile 375 px, including `monitoring.spec.ts` (4) | 11 | 89 | ✅ |
| **Total** | | **411** | **✅ 0 failed, 0 skipped** |

### Representative Module 8 cases

| # | Category | Test | Input | Expected | Actual | ✓ |
|---|---|---|---|---|---|---|
| 1 | Unit (rules) | Heartbeat alone | Enrolled, fresh heartbeat, no reports | Unknown, "Awaiting the first agent reports" | As expected | ✅ |
| 2 | Unit (rules) | Offline | Heartbeat older than the threshold, even with reports | Offline with the heartbeat age | As expected | ✅ |
| 3 | Unit (rules) | Healthy / critical / stale | Fresh available DB; DB unavailable; report older than the stale threshold | Healthy with no findings; Critical; Degraded `reports_stale` | As expected | ✅ |
| 4 | Unit (rules) | Thresholds | CPU 85 %; memory 96 %; disk 85 %; all null | Degraded; Critical; `disk_warn`; Healthy (unmeasured ignored) | As expected | ✅ |
| 5 | Unit (rules) | Services, backup, certificate, PSA | `edge-api` down; worker stale; agent down; backup 3 days old; cert 5 days; expired cert; info-only findings | Critical; Degraded; ignored; Degraded; Degraded; Critical; Healthy with info | As expected | ✅ |
| 6 | Go unit | Delivery | Fake mTLS gateway | After enrollment the outbox is delivered and drained; the batch carries database, host_resources, containers, versions and certificates reports and never the token or key | As expected | ✅ |
| 7 | Integration | Heartbeat only | Enrolled agent heartbeats | `unknown`, honest reason, heartbeat history | As expected | ✅ |
| 8 | Integration | Full report set | 9 valid reports | 200, 9 accepted; deployment **verified** and healthy; all 9 latest types stored; table inventory kept; resource history; `deployment.verified` audited | As expected | ✅ |
| 9 | Security | Strict reports | Extra field in `database`; free text as an error code; a report 1 h in the future; a `ticket_content` type; an empty batch; no client certificate | 6 accepted and 3 rejected with reasons, state unknown, audit without the offending text; 400; 400; 401 | As expected | ✅ |
| 10 | Integration | State transitions | Healthy → DB unavailable → disk 90 % → healthy | critical (reason lists both findings) → degraded `disk_warn` → healthy; events healthy, degraded, critical, healthy; 4 resource samples | As expected | ✅ |
| 11 | Integration | Offline sweep | Heartbeat set 10 min ago; sweep; new heartbeat | Offline (`system` event, "Offline: last heartbeat …"); healthy again | As expected | ✅ |
| 12 | Integration | Policy | Technician PUT; warn ≥ critical; offline < 2 intervals; disk warn 30 % | 403; 400 at `diskCriticalPercent`; 400 at `offlineAfterSeconds`; deployment re-evaluated to degraded, heartbeat now returns 30 s, audit diff `{80 → 30}` | As expected | ✅ |
| 13 | RBAC / isolation | Fleet and health | Viewer and auditor read, cannot change policy; technician on an unassigned client; org B; app role with no context | 200/403; 404; 404 and absent from the fleet; 0 rows in all four tables | As expected | ✅ |
| 14 | **Docker** | Two real appliances | Install A (Autotask) and B (ConnectWise) | Both enrolled **and verified** from their own reports; all 9 report types present; 13 tables; measured CPU and disk; all five services `up`; certificate serial matches; no token or key in any report | As expected | ✅ |
| 15 | **Docker** | Degradation and recovery | Stop `edge-postgres` in A; start it | Local `/healthz` 503; **dashboard critical** ("PostgreSQL is not available"); then 200 and **dashboard healthy** after real reports; timeline healthy → critical → healthy | As expected | ✅ |
| 16 | **Docker** | Outage, persistence, revocation, replay, identity guard | As in Module 7 | Still pass with health evaluation active | As expected | ✅ |
| 17 | E2E | Fleet page | Live agent enrolled and reporting | Synthetic separated; live-only filter; CPU meter 23.4; database Available; state filter | As expected | ✅ |
| 18 | E2E | Deployment health page | No reports → reports → DB unavailable | "Awaiting the first agent reports" → "All checks passed", Verified, disk meter 55, chart, redacted error → critical reason and `database_unavailable` finding; logs page shows the error code and `agent.enrolled` | As expected | ✅ |
| 19 | E2E | Policy page | Warn 97 % (invalid), 50 % (valid), reset; viewer | Inline validation; "Disk usage is 55% (warning above 50%)" on the deployment; 404 for the viewer; no policy link | As expected | ✅ |
| 20 | Accessibility / responsive | axe and 375 px | `/monitoring`, health, logs, `/settings/health` | 0 serious or critical; no horizontal scroll | As expected | ✅ |

## Issues found and resolved

| # | Issue | Cause | Resolution |
|---|---|---|---|
| 1 | The cross-organization sweep found no deployments | FORCE RLS applies to the table owner, so a SECURITY DEFINER query saw nothing | The function sets each organization's context while it looks, and restores the caller's |
| 2 | Migration `0006` failed on the dev database | The default-policy insert hit FORCE RLS for existing organizations | Inserted per organization inside a `DO` block with the organization context |
| 3 | The Docker test timed out waiting for "enrolled" | Appliances were **verified** within a second of enrolling, so the exact-state wait never matched | The test accepts enrolled or verified and asserts verification separately |
| 4 | The live appliance reported `edge-api` as `unknown` (`http_421`) | The appliance API's DNS-rebinding guard rejects every request whose `Host` is not loopback, including the agent's probe of `http://edge-api:8480/healthz` over the compose network | `GET /healthz` (status only, no secrets, loopback-published port) is exempt from the host check; all other routes keep it; Go test covers the service-name probe, the status route and a POST to `/healthz` (both still 421) |
| 5 | A freshly enrolled deployment read "Not evaluated yet" until its first heartbeat (E2E) | Enrollment did not run the rules engine | The gateway evaluates right after enrollment, so the page reads "Awaiting the first agent reports" at once; the integration test asserts it before any heartbeat |
| 6 | `/settings/health` failed the accessibility and 375 px checks: no level-1 heading | The page used a card title only | Page header added, consistent with the other settings pages |
| 7 | 4 test-side issues | A test expected enrollment to record a heartbeat row; an audit list path; the operations administrator holds `settings.manage`; a fleet assertion ran after a policy test had failed without restoring the policy | Fixed in the tests; the policy test restores in `finally` |

## Outstanding

- **Module 9:** the Database Explorer UI on the `database` report (table inventory and detail pages); the agent already sends the catalog inventory.
- **Module 10:** the first-milestone demonstration and control-plane containerization; fleet-scale load test (TEST-LOAD).
- Notifications on state changes (e-mail or chat) are not in the spec's first stage and remain backlog.
- The agent's probe for Docker container states would need the Docker socket, which the hardening forbids; the probe approach stays by design.

## Next module

**Module 9 — Database Explorer:** the per-deployment database page with the real table inventory (name, schema, estimated rows clearly labelled, size, status), database name, version, connection, size, table count, schema and migration version, last inspection and errors; and a table detail page with columns, types, nullability, primary keys, indexes, foreign keys and row-count metadata, all from the agent's catalog inspection, read-only, with no SQL console.
