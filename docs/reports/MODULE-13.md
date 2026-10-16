# Module 13 Completion Report — Remote Management & Upgrades

**Date:** 2026-10-15 · **Environment:** Windows 11, Docker Engine 29.1.3 (WSL), Go 1.25, Node 24.14, PostgreSQL 17, Microsoft Edge (E2E)

## Implementation status: **Complete**

**Test evidence: 514 / 514 passed** on the final code — edge Go 47 (9 new: canonical form, verification and refusal codes, dedupe, worker hand-over, restart, upgrade staging and completion, queued results, remote channel files, dashboard with a staged upgrade, tester requesters; gofmt and vet clean), contracts 47 (4 new), API 274 in 22 files (new `remote-commands.test.ts` with 5 scenarios; both real-Docker suites, now including the remote command scenario with a host-applied upgrade on a real appliance), web unit 32, Playwright E2E 114 (new `operations.spec.ts` with 3 scenarios over real mTLS; the Operations tab joins the accessibility and responsive sweeps). `pnpm typecheck` clean for all three packages. Secret scan over the evidence: 0 hits; no appliance containers or volumes left behind.

**What works now:**
- **Signed remote commands, pulled by the agent.** Every command has an ID, an issuer, a target (deployment *and* installation), a type, parameters, a status, timestamps, an expiry and an audit record. The Control Plane signs it with its Ed25519 command key; the agent, which pinned the public key at enrollment over the gateway certificate the package pins, fetches open commands with its heartbeat, verifies the signature, target, expiry and type, executes each ID once and answers over its mTLS channel. The Control Plane never connects into a client network, and a command that arrives late expires instead of running.
- **A fixed, non-destructive allow-list**: refresh health now, test the PSA connection, run a synchronization pass, restart a service (`edge-api`, `edge-worker` or `edge-agent`: the service answers, exits cleanly and Docker Compose starts it again), rotate the machine certificate, and stage an image upgrade. Suspend, revoke, decommission and uninstall are deliberately not commands (Modules 14–15).
- **Upgrades without a Docker socket.** The appliance stays unprivileged by design, so an upgrade is *staged* by the agent (verified order on the shared volume, instructions on the local dashboard) and applied on the host with the package's new `scripts/upgrade.sh` / `upgrade.ps1` (pull, digest check, `PSA_EDGE_IMAGE` in `.env`, `docker compose up -d`). The new agent recognises the staged order and reports success; the dashboard shows the version that really runs.
- **Operations tab** on each deployment: the six commands as cards with inline confirmation (no dialog), the upgrade target and running version, and a history with status, timestamps, expiry, the appliance's answer and cancellation of pending commands. The health page can ask the appliance to report now. The appliance's own status page lists the commands it handled and any staged upgrade.
- **Verified on real appliances** (Docker suite): all six command types executed end to end by the real agent and worker against the fake PSA, including a worker restart observed through Docker's restart count, a certificate rotation that supersedes the old serial, and a real upgrade from `0.1.0` to a second image (`0.1.0-next`) applied with `scripts/upgrade.sh` and reported by the upgraded agent, with tickets, identity and the local UI intact afterwards.

**Honest limits:**

| Area | Status |
|---|---|
| Unattended upgrades | Not offered: applying an image change needs the Docker socket, which the appliance does not have. The host operator runs the script (or an orchestration tool of their own). A privileged updater sidecar is a backlog option. |
| Signing-key rotation | One key per Control Plane; a different key is logged and ignored by agents. Rotation is a later command type. |
| Agents from before Module 13 | They pin the signing key on their first heartbeat after their image is upgraded (trust on first use over the pinned gateway certificate). |
| Restarting `edge-postgres` / `edge-backup` | Not a command; use the host. |
| Command history retention | Kept indefinitely for now (the table is small); a retention sweep is backlog. |

---

## Deliverables

| Part | Implementation |
|---|---|
| Control Plane database | Migration `0009_remote_commands.sql`: `command_signing_keys` (encrypted private key), `remote_commands` (FORCE RLS, client scope, one open command per type per deployment), agent functions `agent_commands_fetch()` / `agent_command_result()` (SECURITY DEFINER, bound to the certificate's deployment and installation), `app_expire_remote_commands()` sweep with audit. |
| Contracts | `packages/contracts/src/commands.ts`: types, statuses and labels, per-type parameter schemas, `canonicalCommand()` (the signed bytes), `commandIssueSchema`, `commandResultSchema`, `RemoteCommandDto`, `RemoteOperationsDto`. `lastTestedBy` gains `remote`. |
| API | `CommandsService` (signing key, issue / cancel / operations, agent fetch and result, expiry sweep), `CommandsController` (`GET /deployments/:id/operations`, `POST /deployments/:id/commands`, `POST …/commands/:id/cancel`), gateway: `commandSigningKey` in the enrollment and heartbeat responses, commands in the heartbeat response, `POST /agent/v1/command-results`. |
| Appliance (Go) | `internal/agent/commands.go` (canonical form, Ed25519 verification, allow-list, dedupe, execution, result queue surviving outages, upgrade staging and completion), `internal/remote` (request / result files on the shared volume, staged order, command history for the local UI), worker and local API request handlers (`HandleRemote`, restart by clean exit), `versions.image` now reports the version the binary runs, migration `0005_remote_commands.sql` (`tested_by = 'remote'`). |
| Package | `scripts/upgrade.sh` and `scripts/upgrade.ps1`; `INSTALL.md` §6 and the README file table. |
| Web | Operations tab (`/deployments/[id]/operations`), `RemoteOperations` component, `ReportNowButton` on the health page, remote-triggered tests labelled on the PSA pages. |
| Docs | `ARCHITECTURE.md` §4.13, `SECURITY.md`, `UI_DESIGN.md` §14, `RUNBOOKS.md` §8, `MODULE_PLAN.md`, README. |

## Security

- **Authenticity and binding.** Ed25519 over a canonical JSON of the command (ID, type, deployment, installation, sorted parameters, issue time, expiry, key ID). The agent refuses a bad signature, an unknown key, a foreign target, a past expiry or an unknown type, reports the refusal as a failed result with its code, and never executes an ID twice.
- **Authorization.** Issuing needs `deployments.commands.issue` (Technical and Super Administrators); reading needs `deployments.read`; another organization gets 404; RLS scopes the table by client. The agent side is authenticated by its machine certificate: results are accepted only for the caller's own deployment and installation, and only while the command is open.
- **Least privilege on the appliance.** The agent keeps the read-only inspector role and no Docker socket; worker and API work is handed over through request files on the shared volume and done with each service's own privileges. The upgrade order is applied by the host operator, and production refuses images that are not pinned by digest.
- **Nothing destructive, by construction.** The allow-list is fixed in the agent binary and in the contracts; the tests assert that suspend, revoke, decommission, uninstall and wipe are not command types.
- **Audit on both sides.** `deployment.command.issued` / `.cancelled` (user), `.staged` / `.completed` (agent actor; failures carry outcome *failure*), `.expired` (system); the appliance logs restarts in its integration log and keeps its own command history.

## Testing — executed results

Raw output in [`module-13/`](module-13): `edge-go-test.txt`, `typecheck.txt`, `contracts-vitest.txt`, `api-vitest.txt` (both real-Docker suites, including the remote command scenario with the host-side upgrade), `web-vitest.txt`, `e2e-playwright.txt`, `upgrade-sh-output.txt`, `operations-sample.json`, `appliance-agent-status.json`; screenshots in [`module-13/screenshots/`](module-13/screenshots).

| Suite | Command | Result | Evidence |
|---|---|---|---|
| Edge appliance (Go 1.25, in Docker) | `gofmt -l . ; go vet ./... && go test -cover ./...` | **47 passed**, format and vet clean — `internal/agent`: canonical bytes identical to the contract, forged / foreign / expired / unknown commands refused with their codes, executed once and answered, rotation and restart, worker hand-over through the shared volume and `no_response`, upgrade staged → refused for a foreign repository → reported once the new version runs, results queued across an outage, no private material in the state; `internal/api`: dashboard renders the staged upgrade and the command history, and renders completely after a synchronization; `internal/psa`: requester allow-list. 8 packages `ok` | `edge-go-test.txt` |
| Typecheck | `pnpm typecheck` | **clean** (contracts, api, web) | `typecheck.txt` |
| Contracts (Vitest) | `packages/contracts` | **47 passed** (8 files) — command types / statuses / labels, non-destructive list, issue and parameter schemas, deterministic canonical form, result schema | `contracts-vitest.txt` |
| API (Vitest unit + integration) | `apps/api` | **274 passed** (22 files) — `remote-commands.test.ts`: signed command delivered with the heartbeat and verified against the enrollment-time key, result over mTLS, audit at every step, one open per type, per-type validation, upgrade target from configuration and *already up to date*, cancel only pending, expiry sweep with audit and no late revival, RBAC (viewer and ops refused, tech allowed), isolation (other organization 404, another appliance cannot answer, no certificate 401), malformed results; migration inventory includes the two new tables. `edge-docker.test.ts` (15 scenarios, two real appliances): refresh, PSA test (`tested_by = 'remote'`), synchronization (`trigger = 'remote'`), worker restart observed through Docker's restart count and the appliance log, certificate rotation superseding the old serial, upgrade staged (agent status, local dashboard notice) and applied with `scripts/upgrade.sh`, reported by the upgraded agent, tickets / identity / local UI intact, `verify.sh` clean, six issued and six completed audit events; `package-docker.test.ts` (5) | `api-vitest.txt` |
| Web unit (Vitest) | `apps/web` | **32 passed** (5 files) | `web-vitest.txt` |
| Browser E2E (Playwright, Edge, production build) | `apps/web` | **114 passed** in 4.2 min — Operations tab: issue with inline confirmation, pending → delivered → succeeded with the agent's answer, cancel, staged upgrade then up to date, activity log entries; health page *Ask the appliance to report now*; viewers, drafts and synthetic records; nothing destructive offered; accessibility (axe) and responsive sweeps include the new page | `e2e-playwright.txt` |
| Real appliance walkthrough | `node apps/web/scripts/screenshots-m13.mjs` | one appliance installed on `0.1.0` from a package generated by the dev stack (Control Plane advertising `0.1.0-next`): every command type executed by the real agent and worker, the upgrade staged, applied on the host with `scripts/upgrade.sh` and reported by the upgraded agent; pages captured; appliance removed | `screenshots/`, `upgrade-sh-output.txt`, `operations-sample.json`, `appliance-status-remote.json`, `appliance-agent-status.json` |
| Secret scan | regex over all evidence files | **0 hits** | — |
| Leftovers | `docker ps -a`, `docker volume ls` | **0** `psacc-dep-*` containers or volumes | — |

Coverage by the spec's checklist: unit (canonical form identical in TypeScript and Go, signature verification and every refusal code, dedupe, worker hand-over and `no_response`, restart, upgrade staging and completion, queued results, remote channel files; template rendering of the staged upgrade; contracts), API (issue, validation per type, upgrade target from configuration, one open per type, delivery marking, results, refusal of late or foreign results, cancel, expiry sweep with audit, RBAC, isolation), database (migration 0009, constraints, RLS, SECURITY DEFINER functions), integration (real appliances: all six commands end to end, worker restart observed via Docker, certificate rotation, staged upgrade applied with `scripts/upgrade.sh` and reported by the new agent), UI/E2E (Operations tab flows with a simulated agent over real mTLS, health page action, viewer and draft states, activity log; accessibility and responsive sweeps include the new page), validation (parameters, result schema), auth (session + CSRF; certificate-bound agent routes), tenant isolation, error handling and negative paths, security scan.

## Issues found and resolved

| # | Issue | Cause | Resolution |
|---|---|---|---|
| 1 | The engine unit test `TestInboundMirrorsPagesIsIdempotentAndAdvancesTheWatermark` failed inside the image build | Its fixtures carry fixed PSA timestamps that real time had now passed, and the watermark is the later of the run start and the newest change | The engine's injectable clock is pinned before the fixtures in the test helper |
| 2 | The appliance refused `tested_by = 'remote'` | Module 11's check constraint listed only `local_admin` and `worker` | Appliance migration `0005_remote_commands.sql` (schema `0005`) |
| 3 | Package templates must not contain `{{identifier}}` placeholders, which broke Docker format strings in the upgrade script | The package renderer's placeholder syntax overlaps Docker's template syntax | Format string written as `{{ .RepoDigests }}` (a space after the braces), asserted in the package test |
| 4 | Playwright's "Refresh" button locator matched the *Refresh health now* card | Substring matching of accessible names | Exact-name locator |
| 5 | A command's "running version" came from the package's intended image, not the binary | The `versions.image` report echoed configuration | The agent reports the version it was built into; "up to date" reflects what really runs |
| 6 | On real appliances the remote PSA test ended `test_error` | The tester refused any requester other than the local admin page or the worker (an allow-list from Module 11) | `ValidTester()` accepts `remote` and is unit-tested; the Docker scenario then runs the real test and records `tested_by = 'remote'` |
| 7 | On real appliances the remote synchronization ended `failed` | The appliance's `sync_runs.trigger` check constraint (Module 12) did not allow `remote` | Migration `0005` extends it; the Docker assertions now print the appliance's answer on failure |
| 8 | The appliance dashboard did not show the *Remote commands* card (nor the sections after it) on real appliances, while `/api/status` carried the data | Two Module 12 defects in the *Tickets & synchronization* card, both in the branch that renders once a synchronization has run (which no test executed): it referenced `$.Sync` (the root view has no such field), and it compared the last run's status, a `*string` from the database, with `eq`, which the template engine refuses (`incompatible types for comparison`); the render stopped there and the page was served truncated | Reference fixed to `$.Data.Sync`; the status handler passes plain values; the template test renders the post-synchronization branch and asserts the later sections; the Docker scenario asserts the staged-upgrade notice and prints the appliance's render errors on failure |
| 9 | The Docker scenario read the upgrade's *staged* answer as its final one and failed before the upgraded agent had reported | The wait helper treated `staged` as settled | The upgrade step waits for `succeeded` / `failed` explicitly; the Control Plane table inventory test now lists `remote_commands` and `command_signing_keys` |

## Outstanding

- Unattended upgrades (privileged updater sidecar) as an opt-in profile.
- Signing-key rotation command; retention sweep for the command history.
- Restarting the database and backup services remotely (needs a different mechanism than clean exit).

## Next module

**Module 14 — Licensing, suspension and lifecycle management** (license IDs and entitlements, suspend / resume, lifecycle states). Reply with the module name to proceed.
