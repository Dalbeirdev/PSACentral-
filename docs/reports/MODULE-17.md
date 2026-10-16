# Module 17 Completion Report — Client-initiated deletion from the appliance ("Delete all data and deregister")

**Date:** 2026-10-16 · **Environment:** Windows 11, Docker Engine 29.1.3 (WSL), Go 1.25, Node 24.14, PostgreSQL 17, Microsoft Edge (E2E)

## Implementation status: **Complete**

**573 of 573 executed tests passed** — Go 59 · contracts 54 · API 302 (unit + integration, including both real-Docker suites) · web unit 32 · browser E2E 126; typecheck clean; secret scan 0 hits; no leftover test appliance containers or volumes. The Go, typecheck, contracts, web and E2E numbers come from the final evidence run; Every number comes from one final evidence run of the finished code.

**What works now:**
- **The client can end the service from the appliance, alone.** On the appliance's local admin, *Delete appliance* asks for the typed deployment ID, the administrator's password and an acknowledgement. From that moment PSA work stops, every page of the local admin shows only the progress, and the appliance does the rest by itself.
- **The Control Plane keeps nothing but the audit event.** The agent tells the Control Plane over its own machine certificate (bound to its installation id). In one transaction the Control Plane deletes every record about the deployment — reports, heartbeats, inventory, health events, commands, certificates, packages, enrollment tokens, the deployment itself — and writes `deployment.deleted_by_client` on the client with who asked, the reason, the installation, the certificate serials and the rows deleted. No decommissioning and no retention period stand in the way; the license seat is free again; the client record (the provider's own customer record) stays.
- **The appliance deletes everything it holds**, in the right order: Control Plane first (nothing is deleted while it is unreachable — the agent retries with backoff and the identity and data stay intact), then the database through an owner-defined function that empties every table and leaves one marker, then the files on the shared volume, and last its own certificate, key, outbox and license token. It then reports honestly what only the host operator can remove — the Docker containers, networks and volumes — and names the one command, which no longer needs `--force`.
- **Refusals leave the decision to the client.** If the Control Plane refuses (the provider had revoked, superseded or let the certificate expire), nothing is deleted; the page says why and offers *delete local data without the provider* (password again); the status then states that the Control Plane was not told.
- **Nothing can be triggered remotely.** `delete`, `wipe` and `uninstall` are still refused as remote command types; the provider's explicit removal still requires a decommissioned deployment.
- **Verified on a real appliance** (Docker suite): the local administrator's request through the real local admin UI, wrong ID / wrong password / missing acknowledgement refused, the lock-down, the audit event on the Control Plane with the counts, the agent ending with state `deleted`, every application table empty except the marker, the agent state volume holding only the final state file, the final page readable without a session, and `uninstall.sh --wipe` without `--force` leaving no container, network, volume or secret.

**Honest limits:**

| Area | Status |
|---|---|
| Docker resources | The appliance cannot remove its own containers and volumes (it has no Docker access, by design). The final page and `edge-agent status` name the single command; the backups volume goes with it. |
| Client record | Stays on the Control Plane: it is the provider's customer record and may carry other deployments. Deleting a client is the provider's decision (Clients module). |
| Audit event content | Carries metadata only (code, installation id, serials, counts, who asked, reason). It is the only trace and is never deleted (append-only audit). |
| Without an identity | An appliance that never enrolled, or whose certificate the provider revoked, cannot deregister; it can still delete its local data, and the provider removes the record. |

---

## Deliverables

| Part | Implementation |
|---|---|
| Contracts | `packages/contracts/src/client-deletion.ts`: gateway request / result schemas (strict), the audit action, the appliance's deletion phases, labels and status schema. |
| API | Migration `0013_client_deletion.sql` (`app_remove_deployment(uuid, boolean)` allowed in any lifecycle state when client-initiated; `agent_deletion_tombstone()` for retries; partial index on the audit metadata); `ClientDeletionService` (identify, binding check, one transaction: removal + audit, `already-deleted` on retry); gateway route `POST /agent/v1/delete`. |
| Appliance (Go) | Edge migration `0006_client_deletion.sql` (`edge_wipe_all_data(code)`, owner-defined, needs the code as confirmation); worker: PSA work gate on `service.deletion_requested`, `wipe-data` hand-over handler, early exit once deleted; agent: `internal/agent/deletion.go` (phases, retries, refusal, local-only, identity wipe last, status for the UI and `edge-agent status`); local admin: `/deletion` page (form, progress, refused, done), `/deletion/local`, lock-down of every other page, `Deletion` in the status JSON, nav link, removal page cross-reference. |
| Package templates | `uninstall.sh` / `uninstall.ps1` accept agent state `deleted` for `--wipe` without `--force`. |
| Web | *Activity & audit logs* category *Deleted by clients (from the appliance)*; E2E simulated agent gained `deleteFromAppliance()`. |
| Docs | `ARCHITECTURE.md` §4.17, `SECURITY.md`, `UI_DESIGN.md` §18, `RUNBOOKS.md` §12, `MODULE_PLAN.md`, README, `DEMO-LOCAL.md`. |

## Security

- **Who may delete.** Only a signed-in local administrator on the appliance (loopback-only UI, CSRF-protected form) who types the deployment ID, re-enters the password and acknowledges the consequences. Failed confirmations are audited locally and change nothing.
- **How the Control Plane knows it is the appliance.** Mutual TLS with the machine certificate; the request must name the installation the certificate was issued for (`installation-mismatch` otherwise); `revoked`, `superseded` and `expired` certificates are refused (403), strangers get 401; a `decommissioned` deployment may still be deleted by its client. Rate-limited per identity like every authenticated gateway route.
- **Atomic and traceable.** Removal and audit event in one transaction; the audit metadata passes the secret mask (the count of deleted enrollment tokens is recorded under a plain name so nothing in the trail is redacted); the audit event is the tombstone a retry is answered from.
- **Least privilege kept on the appliance.** The application role still cannot delete audit rows or logs (asserted by the existing least-privilege scenario); the wipe is a `SECURITY DEFINER` function of the schema owner that refuses without the deployment code.
- **No new remote power.** The Control Plane cannot start a deletion; remote command types are unchanged (asserted).

## Testing — executed results

Raw output in [`module-17/`](module-17): `edge-go-test.txt`, `typecheck.txt`, `contracts-vitest.txt`, `api-vitest.txt` (both real-Docker suites, including the client-initiated deletion scenario on a real appliance), `web-vitest.txt`, `e2e-playwright.txt`, `deletion-sample.json`; screenshots in [`module-17/screenshots/`](module-17/screenshots).

| Suite | Command | Result | Evidence |
|---|---|---|---|
| Edge appliance (Go 1.25, in Docker) | `gofmt -l . ; go vet ./... && go test -cover ./...` | **59 passed**, format and vet clean — `internal/agent`: deregistration with the installation binding, hand-over to the worker with the deployment code, waiting for the worker with the identity intact, identity deleted last, no gateway contact afterwards, no token in the status; refusal leaves the decision and the local-only path; retries while the Control Plane is unreachable with identity and data intact; a worker failure retried before the identity goes. `internal/api`: the deletion page in every state (form, waiting, retrying, refused signed-in / anonymous, done), the lock-down of every other page, the page readable without a session. Module 16 and earlier tests unchanged | `edge-go-test.txt` |
| Typecheck | `pnpm typecheck` | **clean** (contracts, api, web) | `typecheck.txt` |
| Contracts (Vitest) | `packages/contracts` | **54 passed** (10 files) — strict request / result / status schemas, phase labels, the audit action | `contracts-vitest.txt` |
| API (Vitest unit + integration) | `apps/api` | **302 passed** (26 files) — `client-deletion.test.ts` (5): one-transaction deletion with per-table counts, 404 afterwards, license seat freed, the audit event's content and masking, `already-deleted` on retry; installation mismatch, malformed body, stranger; revoked refused, decommissioned allowed; remote command types still refused; operator removal still gated. `edge-docker.test.ts` (19 scenarios, two real appliances): the local administrator's request through the real UI (wrong ID, wrong password, missing acknowledgement refused), the lock-down, the audit event on the Control Plane, the agent ending in state `deleted`, every application table empty but the marker, the state volume holding only the final state file, the final page without a session, `uninstall.sh --wipe` without `--force`; every Module 15 / 16 scenario still passes | `api-vitest.txt` |
| Web unit (Vitest) | `apps/web` | **32 passed** (5 files) | `web-vitest.txt` |
| Browser E2E (Playwright, Edge, production build) | `apps/web` | **126 passed** in 4.1m — `client-deletion.spec.ts`: the simulated agent deletes its deployment, the retry is answered `already-deleted`, the deployment is gone from the detail and the list, the audit page shows the category and the actor, the client's activity tab carries the event; every earlier spec unchanged | `e2e-playwright.txt` |
| Real appliance walkthrough | `node apps/web/scripts/screenshots-m17.mjs` | one appliance installed from a package generated by the dev stack: the deletion page, a wrong ID refused, the progress page, the final page, the lock-down, the dashboard afterwards (deployment gone, audit event, client activity), then the package's own `uninstall.sh --wipe` without `--force`; 9 screenshots and `deletion-sample.json` (phases and counts only) | `screenshots/`, `deletion-sample.json` |
| Secret scan | regex over all evidence files | **0 hits** | — |
| Leftovers | `docker ps -a`, `docker volume ls` | **0** test appliance containers or volumes left behind (the workstation's own demo appliance `DEP-00030` is excluded and untouched) | — |

Coverage by the spec's checklist: unit (contracts: strict request / result / status schemas, labels, action; Go agent: deregistration with binding, hand-over to the worker with the code, waiting for the worker, identity deleted last, no gateway contact afterwards, no token in the status, refusal leaves the decision, local-only path, retries while unreachable with identity intact, worker failure retried; Go local admin: form, progress, refused (signed in / anonymous), done, lock-down of every other page, page readable without a session), API (one-transaction deletion with counts, 404 afterwards, seat freed, audit event content and masking, `already-deleted` on retry, installation mismatch, malformed, stranger, revoked refused, decommissioned allowed, remote command types still refused, operator removal still gated), database (migrations on both sides; owner-defined wipe function; tombstone function), integration (real appliance end to end, including the host-side wipe), UI/E2E (deployment gone, audit page category and actor, client activity tab), validation, auth, tenant isolation (tenant transaction; per-organization tombstone search), error handling, security scan.

## Issues found and resolved

| # | Issue | Cause | Resolution |
|---|---|---|---|
| 1 | The audit event's deleted-row counts came out with `[REDACTED]` for enrollment tokens | The audit writer masks any metadata key containing *token* | The count is recorded under a plain name; the test asserts nothing in the trail is masked |
| 2 | The tombstone lookup found nothing | Audit rows are tenant-scoped with no scope-all exception, so a definer function querying them without a tenant context sees no rows | The function searches per organization, like the certificate and token lookups |
| 3 | The appliance's final page did not show the audit event id | Go templates address struct fields, not JSON names, and print pointers as addresses | The view carries the id as a value |
| 4 | A test expected the navigation on an anonymous render | The layout renders the navigation only for a signed-in administrator | Assertion moved to the signed-in render |
| 5 | Three Docker scenarios failed on the appliance's schema version | The new edge migration `0006` moves the schema version to `0006` (six migrations) | Expectations updated; the migration list assertion now names `0006:client_deletion` |
| 6 | The Docker scenario's first run timed out waiting for the Control Plane to delete the record | By the time the scenario runs, appliance B has no identity any more: the revocation scenario revoked its certificate and wiped its state, so the appliance correctly ended in *refused* (no identity). The happy path needs an enrolled appliance | The scenario first re-enrolls B with a new package (the Module 15 runbook step, now exercised on a real appliance: package files refreshed in place, state cleared, stack restarted, new installation id), then runs the deletion; the timeout now also prints the agent's status and log |
| 7 | The first dev-stack walkthrough could not deregister | The dev API migrates only at start; migration `0013` had not been applied to the dev database | `pnpm db:migrate`; the walkthrough then passed end to end (9 screenshots, `deletion-sample.json`) |
| 8 | The re-enrollment prelude of the Docker scenario failed twice | The install script makes the package files mode 444 (an in-place `cp` fails), and a file bind mount follows the inode it was created with: replaced files are only seen by recreated containers, so a restarted agent kept enrolling with the old, already used token | The scenario replaces the files (`cp -f`) and recreates the containers (`up -d --force-recreate`); the lesson is written into the scenario and the Module 15 runbook step |
| 9 | **Product defect found by the above:** the package's `install.sh` started the stack with `up -d`, so re-running it with a refreshed package over an installed appliance (the documented way to re-enroll after a revocation or an expired token) kept the old enrollment file inside the running containers | Same inode binding | `install.sh` now starts with `up -d --force-recreate --remove-orphans`; every service picks up the refreshed files; data volumes are untouched |

## Outstanding

- A provider-side notification (e-mail or dashboard inbox) when a client deletes a deployment; today the audit trail and the client's activity tab carry it.
- Deleting the client record itself from the appliance is intentionally not offered (provider's record).

## Next steps

Module 18: the per-deployment **Verification** tab that aggregates every check. Reply with the module name to proceed.
