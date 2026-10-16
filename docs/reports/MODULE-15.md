# Module 15 Completion Report — Secure Decommissioning and Deployment Removal

**Date:** 2026-10-16 · **Environment:** Windows 11, Docker Engine 29.1.3 (WSL), Go 1.25, Node 24.14, PostgreSQL 17, Microsoft Edge (E2E)

## Implementation status: **Complete**

**542 of 542 executed tests passed** — Go 48 · contracts 47 · API 290 (unit + integration, including both real-Docker suites) · web unit 32 · browser E2E 125; typecheck clean; secret scan 0 hits; no leftover appliance containers or volumes. Every number comes from one final evidence run of the finished code.

**What works now:**
- **Decommissioning as a Control Plane decision.** From the deployment overview, an operator with the new `deployments.decommission` permission opens a full page, reads what will happen on the Control Plane and what will *not* happen on the client's host, gives a reason and types the deployment ID. In one transaction the machine certificate, the enrollment token and the usable package (archive purged) are revoked, open remote commands are cancelled, the record becomes **Decommissioned** (final, with why / by whom / from which state / what was retired) and the license slot is freed. Everything is audited.
- **The appliance learns it honestly and keeps the client's data.** The gateway answers an authenticated `410 decommissioned` to the retired certificate (distinct from a plain revocation, which still means "re-enroll"). The agent treats that as final: no further heartbeats, reports or renewals, and one local hand-over to the worker, which stops PSA connection tests and ticket synchronization and records the flag. The local admin shows *Decommissioned by the provider* on its status and synchronization pages and a new **Removal** page. Tickets, data, backups and credentials stay on the host; nothing is deleted remotely — the Control Plane has no path into the client network and `decommission` / `uninstall` / `wipe` remain, by assertion, not remote commands.
- **Removal on the host, by the operator.** Every package now carries `scripts/uninstall.sh` and `scripts/uninstall.ps1`: without options they stop the appliance and keep the data; `--wipe --confirm DEP-nnnnn` removes the Compose project with its volumes, `./secrets` and `.env` and verifies that nothing of the project remains. The script asks the running agent for its state and refuses to wipe an identity the Control Plane has not retired (`--force` overrides). `UNINSTALL.md`, `INSTALL.md` and the dashboard's removal instructions describe the two-step order: Control Plane first, host second.
- **Retention and explicit removal.** A per-organization retention policy (Settings → *Data retention*, default 90 days, 7–3650) drives an hourly sweep that purges the reports, heartbeats, table inventory, health events and commands of deployments decommissioned longer than the period, auditing each purge; *Purge what is due now* runs it immediately and reports honestly when nothing was due. A decommissioned record can then be removed with a typed confirmation: the record and everything the Control Plane still holds about it are deleted inside the caller's tenant context, the audit trail (including `deployment.removed` with the counts and certificate serials) stays, and the retired certificate is simply unknown to the gateway afterwards.
- **Verified on a real appliance** (Docker suite): decommissioned from the Control Plane, the appliance's agent reports `decommissioned`, stops heartbeating, the worker records the flag and logs it, the banner and Removal page appear, tickets stay; the host-side wipe refuses the wrong code, then removes every container, volume and secret; the record is removed and the client's audit trail keeps enrollment, decommissioning and removal.

**Honest limits:**

| Area | Status |
|---|---|
| Remote wipe / shutdown | Deliberately not implemented, and asserted absent: the Control Plane retires identity material only. Cleaning a host without its operator is an organisational matter. |
| Resuming a decommissioned deployment | Not possible: a new deployment with a new identity is needed (the page says so before the confirmation). |
| Data retention on the appliance | The appliance keeps everything until the host operator wipes it; the Control Plane cannot verify that a wipe happened (the agent no longer reports). The uninstall script verifies it locally. |
| Client offboarding cascade | A client's status is independent of its deployments; decommissioning every deployment before offboarding a client remains the operator's checklist (runbook §10). |

---

## Deliverables

| Part | Implementation |
|---|---|
| Control Plane database | `0012_decommissioning.sql`: `deployments.decommissioned_at / _by / _reason / _from_state`, `decommission_identity`, `metadata_purged_at` (+ constraint and index); `retention_policies` (FORCE RLS); `agent_identify()` answering `decommissioned`; `agent_enrollment_check()` refusing `deployment-decommissioned`; `app_purge_decommissioned()` (retention sweep, audited); `app_remove_deployment()` (ordered deletion inside the tenant context, returns counts). Dev seed: a synthetic decommissioned sample. |
| Contracts | `packages/contracts/src/retention.ts` (`deploymentDecommissionSchema`, `deploymentRemoveSchema`, `DeploymentDecommissionInfo`, `DeploymentRemovalResult`, `retentionPolicySchema`, defaults and limits, `RetentionPolicyDto`, `RetentionPurgeResult`), `DeploymentDetail.decommission`, permission `deployments.decommission` (Super and Operations Administrators). |
| API | `DeploymentsService.decommission()` / `remove()`, routes `POST /deployments/:id/decommission` and `DELETE /deployments/:id`; `RetentionService` / `RetentionController` (`GET/PUT /settings/retention`, `POST /settings/retention/purge`, hourly sweep); gateway messages `decommissioned` (410) and `deployment-decommissioned` (403); commands refuse decommissioned deployments; health rules `deployment_decommissioned`; package builder renders the two uninstall scripts. |
| Appliance (Go) | Agent: `decommissioned` state (final; no heartbeats, reports or renewals; status detail; one hand-over request to the worker; acknowledgement consumed); worker: `decommission` request, `service.decommissioned` flag, PSA work stopped; local admin: lifecycle status, banners, *Sync now* disabled, `/removal` page. |
| Package | `scripts/uninstall.sh` / `uninstall.ps1` (stop; wipe with typed ID; state check; leftover verification), rewritten `UNINSTALL.md`, `INSTALL.md` §7, README table row. |
| Web | `/deployments/[id]/decommission` (full page, typed confirmation), overview *Decommissioned* card with removal instructions and *Remove from the Control Plane*, lifecycle tracker history, list stage cards *Suspended* / *Decommissioned*, Operations and Health wording, `/settings/retention` with statistics, form and *Purge now*; navigation marks Module 15 delivered. |
| Docs | `ARCHITECTURE.md` §4.15, `SECURITY.md`, `UI_DESIGN.md` §16, `RUNBOOKS.md` §10, `MODULE_PLAN.md`, README. |

## Security

- **Authorization.** `deployments.decommission` is a separate permission (Super and Operations Administrators): holding `deployments.write` (Technical Administrators) is not enough to retire an identity or delete a record; the integration tests check that, the viewer refusal and the other organization's 404. Retention policy: `settings.read` / `settings.manage`.
- **Typed confirmation, inline.** Decommissioning and removal require the deployment ID typed exactly (case-insensitive) in addition to the permission and, for decommissioning, a reason kept in the audit log. No dialogs.
- **Identity retirement is complete and immediate.** Certificate, token, package archive and open commands are retired in one transaction; `agent_identify()` makes every mTLS request of that certificate answer `decommissioned` from then on, `agent_enrollment_check()` refuses the deployment's tokens, readiness blocks packages, `issuable()` blocks commands, suspend / resume / settings refuse the final state.
- **Nothing destructive reaches the appliance.** The agent only receives an authenticated refusal over the pinned CA; the worker hand-over is a local file on the shared volume, not a signed command; the uninstall scripts run on the host, need the typed ID and refuse to wipe an active identity. The Module 13 tests still assert that `decommission`, `uninstall` and `wipe` are not command types.
- **Deletion stays tenant-scoped and audited.** `app_remove_deployment()` runs inside the caller's tenant context (FORCE RLS applies), deletes in foreign-key order and returns counts that go into `deployment.removed`; the retention sweep audits every purge as the system actor. `audit_events` remain append-only and survive removal.
- **No secrets in evidence.** The sample files hold identifiers, states and counts only; the evidence scan found 0 hits.

## Testing — executed results

Raw output in [`module-15/`](module-15): `edge-go-test.txt`, `typecheck.txt`, `contracts-vitest.txt`, `api-vitest.txt` (both real-Docker suites, including the decommissioning and host-side wipe scenario on a real appliance), `web-vitest.txt`, `e2e-playwright.txt`, `uninstall-sh-output.txt`, `decommission-sample.json`; screenshots in [`module-15/screenshots/`](module-15/screenshots).

| Suite | Command | Result | Evidence |
|---|---|---|---|
| Edge appliance (Go 1.25, in Docker) | `gofmt -l . ; go vet ./... && go test -cover ./...` | **48 passed**, format and vet clean — `internal/agent`: a `decommissioned` answer retires the identity (state, detail, no further heartbeats or reports), one hand-over request reaches the worker and its acknowledgement is consumed, a plain `revoked` stays distinct; `internal/api`: the Removal page renders the banner and the typed-ID wipe commands; every earlier suite unchanged. 8 packages `ok` | `edge-go-test.txt` |
| Typecheck | `pnpm typecheck` | **clean** (contracts, api, web) | `typecheck.txt` |
| Contracts (Vitest) | `packages/contracts` | **47 passed** (8 files) — the new permission is known to the roles and held by Super / Operations Administrators only; `decommission`, `uninstall` and `wipe` are still not command types | `contracts-vitest.txt` |
| API (Vitest unit + integration) | `apps/api` | **290 passed** (24 files) — `decommission.test.ts` (6): identity retirement from enrolled / suspended / draft with counts, validation and typed ID, RBAC and isolation, gateway `410 decommissioned` on heartbeat / reports / renew and `deployment-decommissioned` on enrollment, finality, health finding, list and stats, audit; retention default / validation / isolation / audit / purge of due metadata only / statistics; removal preconditions, deletion counts, 404, gateway `unknown`, audit on the client. `edge-docker.test.ts` (17 scenarios, two real appliances): decommissioning observed on the real appliance (agent state, worker flag, log, banner, Removal page, synchronization stopped, tickets kept, no heartbeat), host-side `uninstall.sh --wipe --confirm` refusing the wrong ID then leaving no container, volume or secret, record removed with the audit trail intact. `package-builder.test.ts`: uninstall scripts and guide. `health-rules.test.ts`: the final state. `database.test.ts`: migration 0012 inventory and RLS | `api-vitest.txt` |
| Web unit (Vitest) | `apps/web` | **32 passed** (5 files) | `web-vitest.txt` |
| Browser E2E (Playwright, Edge, production build) | `apps/web` | **125 passed** in 4.2m — `decommission.spec.ts`: full-page decommissioning with inline validation and the typed ID, overview card and removal instructions, simulated agent refused with `decommissioned`, Operations / Health / activity wording, list stage filter, removal of the record to a real 404 and `unknown` at the gateway; retention settings validation, save, purge now, audit; Technical Administrators and viewers see no decommission control and are refused by the API; synthetic sample read-only; accessibility (axe) and responsive sweeps include the retention page; packages list the uninstall scripts | `e2e-playwright.txt` |
| Real appliance walkthrough | `node apps/web/scripts/screenshots-m15.mjs` | one appliance installed from a package generated by the dev stack, verified against the fake PSA, decommissioned on the full page; appliance banner, Removal page and stopped synchronization captured; `uninstall.sh --wipe --confirm` refused with the wrong ID, then removed every container, volume and secret (output kept); retention page captured; record removed with an inline confirmation; audit trail captured; 9 screenshots, `uninstall-sh-output.txt`, `decommission-sample.json` | `screenshots/`, `uninstall-sh-output.txt`, `decommission-sample.json` |
| Secret scan | regex over all evidence files | **0 hits** | — |
| Leftovers | `docker ps -a`, `docker volume ls` | **0** `psacc-dep-*` containers or volumes | — |

Coverage by the spec's checklist: unit (health rule for the final state; Go: the agent's reaction to `decommissioned` vs `revoked`, the hand-over and its acknowledgement, no further contact; local admin templates incl. the Removal page; package builder: uninstall scripts with the typed ID and the state check, rewritten guide), API (decommission from enrolled / suspended / draft, validation of the reason and the typed ID, RBAC and isolation, identity retirement counts, gateway `410 decommissioned` on heartbeat / reports / renew and `deployment-decommissioned` on enrollment, finality of packages / commands / suspend / resume / revoke, health finding, list filter and stats, audit; retention defaults, validation, isolation, audit, purge of due metadata only with audit, statistics; removal preconditions, typed ID, RBAC, deletion counts, 404 afterwards, gateway `unknown`, audit on the client), database (migration 0012 inventory, RLS on `retention_policies`, SECURITY DEFINER functions), integration (real appliance end to end incl. the host-side wipe and leftover verification), UI/E2E (full-page decommission with inline validation, overview card, removal instructions, list stage, record removal to a real 404, retention page save / validation / purge, permission-dependent controls, synthetic sample; accessibility and responsive sweeps include the retention page), validation, auth (session + CSRF), tenant isolation, error handling and negative paths, security scan.

## Issues found and resolved

| # | Issue | Cause | Resolution |
|---|---|---|---|
| 1 | The agent's hand-over to the worker was silently dropped in the first run | The shared-volume request writer accepts UUID-shaped ids only; the first id was a timestamp | A random UUID-shaped id; the unit test now asserts the request reaches the worker and its answer is consumed |
| 2 | The health page of a purged deployment showed no finding | Findings are stored at evaluation time; nothing re-evaluates a deployment that no longer reports | Decommissioning stores the `deployment_decommissioned` finding with the state; the purge keeps it (asserted) |
| 3 | The renewal check in the new API test answered 400 instead of 410 | The renew body schema is strict (`csr` only) | Test fixed to send a strict body; the gateway refuses the retired certificate before any renewal |
| 4 | The old uninstall guide assertion (`down --volumes`) failed | The guide now hands over to the scripts | Assertion updated to the typed-ID wipe command |
| 5 | `del()` in the API test client could not carry a body | The helper was written for body-less deletes | Optional body added (the removal route takes the typed ID) |

## Outstanding

- Optional organisational cascade: offboarding a client could require (or perform) the decommissioning of its deployments.
- An operator-side acknowledgement that the host wipe was done (today only the uninstall script verifies it locally; the Control Plane cannot know).
- Export of a decommissioned deployment's audit trail as a signed archive before removal (the trail stays in the audit log; a packaged export is backlog).

## Next steps

All 15 modules of the master specification are delivered. Remaining work is the cross-cutting backlog in `docs/MODULE_PLAN.md` (OIDC sign-in, KMS-held keys, image export for air-gapped clients, PSA-specific synchronization for further providers) and production hardening per `docs/ENVIRONMENTS.md`. Nothing has been committed; say the word if you want a commit and push of the whole tree.
