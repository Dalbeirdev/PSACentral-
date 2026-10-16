# Module 12 Completion Report — Advanced PSA Synchronization

**Date:** 2026-10-15 · **Environment:** Windows 11, Docker Engine 29.1.3 (WSL), Go 1.25, Node 24.14, PostgreSQL 17, Microsoft Edge (E2E)

## Implementation status: **Complete**

**Test evidence: 492 / 492 passed** on the final code — edge Go 38 (6 new engine and adapter tests; gofmt and vet clean), contracts 43 (1 new), API 268 in 21 files (synchronization counters in the appliance status and fleet view, health findings, the instance's last successful synchronization; both real-Docker suites, now including the end-to-end synchronization scenario on a real appliance), web unit 32, Playwright E2E 111 (`integrations.spec.ts` extended with the synchronization and ticket columns and the deployment health card). `pnpm typecheck` clean for all three packages. Secret scan over the evidence: 0 hits; no appliance containers or volumes left behind.

**What works now:**
- **The appliance is the system of record for tickets.** A synchronization engine on the appliance mirrors the client's PSA tickets into its own database (incremental on the PSA's clock with an overlap window, normalized statuses and priorities beside the PSA's labels, idempotent events), pushes changes made on the appliance back to the PSA (status changes, notes, and new tickets where the adapter supports it), detects conflicts (the PSA wins, the conflict is kept on the timeline) and records every run with counts and a stable error code.
- **Adapters**: Autotask and ConnectWise ticket listing, status updates and notes follow the reference connectors (incremental `lastActivityDate` / `lastUpdated` queries, Autotask picklist labels, ConnectWise board statuses and PATCH operations); a documented custom REST shape covers any PSA with a plain ticket API and is what the real-appliance tests exercise end to end. HaloPSA, Kaseya BMS, Freshservice and ServiceNow keep their connection tests and report `sync_unsupported` honestly.
- **Ticket management on the appliance**: Tickets list (filters, search, sync-state pills), ticket detail with the timeline and per-change push outcome, status change and notes, new tickets, and a Synchronization page (state, runs, *Sync now*). The worker runs every 5 minutes once the connection is verified (configurable, with backoff), or immediately on request.
- **The Control Plane sees counts only**: the agent's ticket and synchronization reports carry totals, open counts, pending pushes, conflicts, run statuses and codes. They appear on the Integrations page (new Synchronization and Tickets columns), the PSA instance page and the deployment health page; health rules flag failed runs (degraded) and partial runs or conflicts (informational). The real-appliance suite asserts that no title, description, note text or requester address exists anywhere in the Control Plane's report store.
- **Verified on real appliances** (Docker suite): three tickets mirrored from the fake PSA with normalized statuses and the watermark set to the newest PSA change; a status change and a note made on the appliance pushed to the PSA; a ticket raised on the appliance created in the PSA and given its id; a conflict (the PSA closed a ticket while a local change waited) resolved in the PSA's favour with the superseded change never pushed; counts and statuses visible centrally.

**Honest limits:**

| Area | Status |
|---|---|
| Vendor verification | Autotask and ConnectWise synchronization is implemented after the reference connectors and verified against fake servers in the Go tests; no live tenant was available. The custom REST adapter is verified end to end on real appliances. |
| Creating tickets in Autotask / ConnectWise | Needs a company (and, for ConnectWise, a board) mapping that the platform does not hold yet; such tickets stay `local_only` and the appliance says so. |
| Scope of the mirror | Tickets, statuses, priorities, requester e-mail, resolution and due dates, notes written on the appliance. Attachments, time entries, assignments and inbound notes are not mirrored in this version. |
| Conflict policy | Fixed: the PSA wins for statuses; local notes always travel. No per-client policy yet. |
| Central history | Counts per report interval; the appliance's own pages hold the detail. |

---

## Deliverables

| Part | Implementation |
|---|---|
| Appliance database | Migration `0004_ticket_sync.sql`: `origin`, `sync_state`, `last_synced_at`, `local_changed_at` on `helpdesk_tickets`; `pushed_at` / `push_error` on `ticket_events`; `trigger`, watermarks, `pages` on `sync_runs`; `edge_sync_status()` for the inspector role (counts only). Tables stay 14; schema 0004. |
| Engine | `apps/edge/internal/sync`: `Store` interface (`PgStore` on PostgreSQL; an in-memory store in the unit tests), `Engine.Run()` (inbound paging, upsert with idempotent events, conflict handling, outbound pushes, run bookkeeping, watermark), stable codes. |
| Adapters | `apps/edge/internal/psa/tickets.go`: `ListTickets`, `UpdateTicket`, `AddNote`, `CreateTicket` for Autotask, ConnectWise and custom REST; `NormalizeStatus` / `NormalizePriority`; `SyncSupported`. |
| Worker | Scheduled passes (`PSA_EDGE_SYNC_INTERVAL`, default 5 m, backoff to 30 m), manual runs from the UI, honest start-up log per provider. |
| Local admin UI | `/tickets`, `/tickets/new`, `/tickets/{id}` (status change, notes, timeline), `/sync` (state, runs, *Sync now*); dashboard card; `/api/status` carries ticket and sync summaries. Audited: `ticket.created`, `ticket.status`, `ticket.note`, `sync.requested`. |
| Agent report | `ticket_processing_metrics` adds `pendingOutbound`, `conflictsLast24h`, `localOnly`, `pushFailed`; `synchronization` adds `implemented`, `lastSucceededAt`, `runsLast24h`, `failedRunsLast24h`, `watermark` (optional fields; old agents still validate). |
| Contracts / API | Optional report fields; `PsaApplianceStatus.sync` / `.tickets` filled from the latest reports; health rules `sync_partial`, `sync_conflicts`. |
| Web | Integrations page columns; PSA instance connection card rows; deployment health *Tickets & synchronization* card. |
| Package | Compose passes `PSA_EDGE_SYNC_INTERVAL` and `PSA_EDGE_PSA_TEST_INTERVAL` from the appliance `.env` (documented in the template). |
| Docs | `ARCHITECTURE.md` §4.12, `UI_DESIGN.md` §13, `RUNBOOKS.md` §7, `MODULE_PLAN.md`, README. |

## Security

- **Ticket content stays on the appliance.** Reports and APIs carry counts, statuses and codes; the Docker suite searches the Control Plane's `deployment_reports` for the fake tickets' titles, descriptions, note text and requester domain (0 hits), and the API test asserts the appliance status carries no `title` / `description` keys. There is deliberately no ticket browser on the Control Plane.
- **Outbound only, bounded**: each run is a bounded number of requests from the client's Docker environment with the hardened client (TLS 1.2+, timeouts, private CA); credentials are decrypted only for the run.
- **Local changes are auditable**: every change on the appliance is a `portal` event with its push outcome; the local admin's actions are audited on the appliance.
- **Honest states**: `sync_unsupported` for providers without an adapter, `psa_not_verified` until a real connection test passed, `local_only` for tickets the PSA cannot receive, `conflict` when the PSA overrode a local change.

## Testing — executed results

Raw output in [`module-12/`](module-12): `edge-go-test.txt`, `typecheck.txt`, `contracts-vitest.txt`, `api-vitest.txt` (both real-Docker suites, including the synchronization scenario), `web-vitest.txt`, `e2e-playwright.txt`; screenshots in [`module-12/screenshots/`](module-12/screenshots) (appliance tickets, ticket timeline with pushes, synchronization page; Control Plane health card and Integrations columns).

| Suite | Command | Result | Evidence |
|---|---|---|---|
| Edge appliance (Go 1.25, in Docker) | `gofmt -l . ; go vet ./... && go test -cover ./...` | **38 passed**, format and vet clean — `internal/sync`: inbound paging, idempotent events and watermark; outbound status / notes / new tickets; conflict (PSA wins, notes still travel); failure codes, recovery, unsupported provider, Autotask create refusal; status and priority normalization. `internal/api`: the four new pages render (ticket timeline shows the push time). 8 packages `ok` | `edge-go-test.txt` |
| Typecheck | `pnpm typecheck` | **clean** (contracts, api, web) | `typecheck.txt` |
| Contracts (Vitest) | `packages/contracts` | **43 passed** (7 files) — optional synchronization and ticket counters validate, old reports still validate, projection helpers | `contracts-vitest.txt` |
| API (Vitest unit + integration) | `apps/api` | **268 passed** (21 files) — health rules `sync_failed` / `sync_partial` / `sync_conflicts`; appliance status carries `sync` and `tickets` (counts only, no `title` / `description`), fleet view, instance `lastSyncAt` from the report; RBAC and isolation unchanged. `edge-docker.test.ts` (14 scenarios, two real appliances): three tickets mirrored with normalized statuses and a sane watermark, status change and note pushed to the fake PSA, a ticket raised on the appliance created in the PSA and given its id, conflict resolved in the PSA's favour with the superseded change never pushed, counts and statuses visible centrally, the Control Plane's report store free of ticket titles, descriptions, note text and requester addresses; migration 0004 applied (schema `0004`, 14 tables) | `api-vitest.txt` |
| Web unit (Vitest) | `apps/web` | **32 passed** (5 files) | `web-vitest.txt` |
| Browser E2E (Playwright, Edge, production build) | `apps/web` | **111 passed** in 3.8 min — Integrations page Synchronization and Tickets columns after simulated reports over real mTLS, deployment health *Tickets & synchronization* card, PSA instance connection card; accessibility (axe) and responsive sweeps unchanged | `e2e-playwright.txt` |
| Real appliance walkthrough | `node apps/web/scripts/screenshots-m12.mjs` | one appliance installed from a generated package against the fake PSA (TLS, private CA, four tickets): verified → synchronized → status change, note and new ticket pushed → pages captured → removed | `screenshots/`, `appliance-sync-runs.txt`, `control-plane-report-sample.json` |
| Secret scan | regex over all evidence files | **0 hits** | — |
| Leftovers | `docker ps -a`, `docker volume ls` | **0** `psacc-dep-*` containers or volumes | — |

Coverage by the spec's checklist: unit (engine inbound paging, idempotency, watermark, normalization, outbound status/notes/create, conflict policy, failure codes and recovery, unsupported provider, Autotask create refusal; template rendering of the four new pages; contracts; health rules), API (projection of sync and ticket counters, health findings, fleet view), database (migration 0004, constraints, inspector function), integration (real appliances against a fake PSA: mirror, push, create, conflict, counts centrally, data boundary), UI/E2E (Integrations columns and deployment health card after simulated reports; local admin pages exercised through HTTP in the Docker suite), responsive and accessibility sweeps unchanged and passing, validation (ticket form), auth (local admin session + CSRF on every action), tenant isolation (unchanged), error handling and negative paths, security scan.

## Issues found and resolved

| # | Issue | Cause | Resolution |
|---|---|---|---|
| 1 | The screenshot helper's in-process fake PSA could not serve the appliance | Synchronous shell calls blocked the Node event loop during the appliance's request | The fake PSA runs as its own process (`apps/web/scripts/fake-psa.mjs`), now with ticket endpoints |
| 2 | gofmt rewrote the appliance `Status` struct alignment, breaking a scripted edit anchor | Formatting applied after Module 11 | Anchors updated; `gofmt -l -w` is part of the Go evidence command |
| 4 | Running the screenshot capture while the Docker suite ran destroyed a test appliance | After a dev reseed the dev organization's deployment codes restart at `DEP-00028`, the same codes the test organization uses, so both installs mapped to one Compose project | Runs are kept sequential; recorded as an environment rule (the codes are per organization by design) |
| 5 | The first scheduled synchronization ran before the fake PSA held any ticket, so the watermark moved past the demo tickets | Correct engine behaviour (only changes after the watermark are fetched); a test-sequencing issue | The fake PSA holds its tickets from the start, like a real PSA at first sync; the Module 9 column count assertion was updated for the four new columns |
| 6 | The conflict step of the Docker scenario raced with the appliance's 20-second scheduled run (the local change was pushed before the PSA closed the ticket) | Scheduled runs and the test's explicit sequence interleaved | The scenario keeps the default 5-minute schedule and drives every step with *Sync now*; the engine's behaviour was correct in both orders |
| 3 | The worker's start-up log still claimed synchronization was unimplemented | Text from Module 7 | Logs the real capability per provider |
| 7 | The conflict step of the real-appliance scenario timed out: the PSA's *close* was never fetched and the local change was pushed without a conflict | The fake PSA's tickets carried fixed timestamps later than the machine clock; the engine correctly set the watermark to the newest PSA change (in the future), so a change made "now" fell below the watermark | Test data made relative to the run clock in the Docker suite and the demo fake PSA; the run diagnostics (runs, ticket, events, watermark) that exposed this stay in the suite |
| 8 | Both real-appliance suites failed at enrollment with empty diagnostics after the workstation changed network | `hostname -I` listed a Docker bridge (`172.20.0.1`) first once other Compose networks existed, and the dev `AGENT_GATEWAY_URL` still named the previous LAN address | Host address derived from the default route's source address (suite, screenshot helpers, `pnpm cp:setup`); the rule is documented in `ENVIRONMENTS.md` |
| 9 | The ticket timeline showed "pushed —" instead of the push time (seen in the screenshot review) | The template's time formatter did not accept the nullable (pointer) `pushed_at` value | Formatter accepts both; the template test now asserts the push time is rendered |
| 10 | The PSA instance page showed "Last synchronization" twice — the appliance's last run and a Module 7 placeholder stuck at "Never" | The instance-level `last_sync_at` was never fed by reports | The `synchronization` report now updates the instance's last successful synchronization (API test asserts it); the rows are "Last synchronization run" (appliance) and "Last successful synchronization" (instance); the explainer no longer says synchronization "arrives in Module 12" |

## Outstanding

- Company / board mapping so tickets raised on the appliance can be created in Autotask and ConnectWise.
- Attachments, time entries and inbound notes; per-client conflict policy.
- Live-tenant verification of the Autotask and ConnectWise synchronization paths.

## Next module

**Module 13 — Remote management & upgrades** (signed remote commands with ID / issuer / target / status / expiry and audit, service restart, certificate rotation, appliance upgrades). Reply with the module name to proceed.
