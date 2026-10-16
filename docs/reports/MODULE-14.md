# Module 14 Completion Report — Licensing, Suspension and Lifecycle Management

**Date:** 2026-10-16 · **Environment:** Windows 11, Docker Engine 29.1.3 (WSL), Go 1.25, Node 24.14, PostgreSQL 17, Microsoft Edge (E2E)

## Implementation status: **Complete**

**529 of 529 executed tests passed** — Go 47 · contracts 47 · API 282 (unit + integration, including both real-Docker suites) · web unit 32 · browser E2E 121; typecheck clean; secret scan 0 hits; no leftover appliance containers or volumes. The full evidence job was run again after the two fixes recorded as issues 9 and 10, so every number comes from one final run.

**What works now:**
- **Licenses as first-class entitlements.** Each license has its own identifier (`LIC-xxxxx`, one of the appliance identifiers the spec lists), a client, a plan name, a term (start, optional end), a maximum number of deployments and a status (active, suspended, expired, revoked). Expiry is swept hourly and audited; readers already show a lapsed license as expired before the sweep. Suspend, resume, revoke and edits are audited with reasons.
- **Entitlement where it matters.** Deployments bind to a license (automatically to the client's active license with free capacity, or explicitly in a draft's settings). The readiness check *Active license with capacity* gates package generation; the gateway refuses enrollment with `license-missing`, `license-inactive` or `deployment-suspended`. The package carries the license identifier; the appliance shows it and enforces nothing itself — entitlement decisions stay on the Control Plane.
- **Reversible suspension of a deployment.** Suspend (reason required) keeps the previous lifecycle state, blocks packages, enrollment and operator commands, and sends the enrolled appliance a signed `suspend` command through the Module 13 framework: the worker pauses PSA connection tests and ticket synchronization, the local admin shows a *Suspended by the provider* banner with *Sync now* disabled, and tickets, data and the local UI stay untouched. Resume restores the state and sends `resume`; a pending *Sync now* then runs. Heartbeats and reports continue throughout so the appliance stays reachable.
- **Dashboard.** A Licenses section (count cards as filters, search, status, expiring-soon filter, list, full-page create / edit, detail with deployments, actions and audit activity), a Licenses card on every client, the License ID on the deployment identity card, lifecycle actions on the deployment overview, a license selector in draft settings, lifecycle commands in the Operations history, and health findings for lifecycle and licensing.
- **Verified on real appliances** (Docker suite): a suspended deployment's appliance records the flag, logs it, shows the banner, ignores a *Sync now* for a full worker tick and runs no PSA work, while heartbeats continue and the Control Plane refuses packages and commands; after resume the pending synchronization runs and operations work again.

**Honest limits:**

| Area | Status |
|---|---|
| License suspension vs running appliances | Suspending or revoking a license stops packages and enrollment but does not touch running appliances; suspend deployments deliberately (the page says so). Automatic cascading is a policy decision left for the operator. |
| Entitlement enforcement on the appliance | None by design: the appliance keeps working during a Control Plane outage (AD-13); the Control Plane enforces licensing at package, enrollment and command time and flags it in health. |
| Seat-level or feature-level licensing | Not modelled; a license limits the number of deployments and carries a plan name. |
| Decommissioning | Module 15 (decommissioned deployments already do not count towards a license). |

---

## Deliverables

| Part | Implementation |
|---|---|
| Control Plane database | `0010_licenses_lifecycle.sql`: `licenses` (FORCE RLS, client scope), `deployments.license_id` + suspension columns and constraint, `remote_commands` types `suspend` / `resume`, `agent_enrollment_check()` with licensing and suspension refusals, `app_expire_licenses()`; `0011_license_sequence.sql` (`LIC` codes). Dev seed: synthetic licenses per client (some expiring, one suspended, one past its date) and bound deployments. |
| Contracts | `packages/contracts/src/licenses.ts` (statuses, labels, create / update / action / list schemas, DTOs, `deploymentSuspendSchema`, license and suspension info on deployments), `EdgeConfigV1.license`, `OPERATOR_COMMAND_TYPES` vs lifecycle-only command types, audit list `targetType` / `targetId` filters. |
| API | `LicensesService` / `LicensesController` (`/licenses` list, stats, create, detail, update, suspend, resume, revoke; hourly expiry sweep), deployments: license binding, readiness gate, `suspend` / `resume` routes, `CommandsService.issueIn()` for lifecycle commands, health rules `deployment_suspended`, `license_missing`, `license_inactive`, `license_expiring`, gateway refusal messages, package builder license field. |
| Appliance (Go) | `config.Edge.License`; agent allow-list `suspend` / `resume` relayed to the worker; worker `Suspended()` flag (`app_metadata.service.suspended`), paused tests and synchronization, `suspended` answers; local admin banners on the status and synchronization pages, *Sync now* disabled, license identifier and lifecycle on the status page. |
| Web | `/licenses`, `/licenses/new`, `/licenses/[id]`, `/licenses/[id]/edit`; `LicenseForm`, `LicenseActions`, badges; client Licenses card; deployment License ID row, `LifecycleActions`, draft license selector; the Licenses sidebar entry is delivered (no placeholder left). |
| Docs | `ARCHITECTURE.md` §4.14, `SECURITY.md`, `UI_DESIGN.md` §15, `RUNBOOKS.md` §9, `MODULE_PLAN.md`, README. |

## Security

- **Authorization.** `licenses.read` for every role, `licenses.manage` for Super and Operations Administrators; deployment suspend / resume needs `deployments.write`; the integration tests check viewer and technical-administrator refusals and another organization's 404s. Licenses use FORCE RLS with client scope like every client-owned table.
- **Enforcement points.** Package generation (readiness), enrollment (`agent_enrollment_check()` inside the database), operator commands (`not-issuable` while suspended), resume (needs an active license). The appliance never decides entitlement, so a Control Plane outage cannot stop a client's operations (AD-13).
- **Reversibility and audit.** Suspension keeps the previous state and reason, is audited on both sides (`deployment.suspended` / `.resumed`, the appliance's integration log) and reaches the appliance only as a signed, expiring command. Nothing is deleted; revocation of a license is explicit and final.
- **Honest states.** Expired licenses are reported as expired before the sweep; a full license shows *full*; drafts without a license say so on the overview and in the readiness check.

## Testing — executed results

Raw output in [`module-14/`](module-14): `edge-go-test.txt`, `typecheck.txt`, `contracts-vitest.txt`, `api-vitest.txt` (both real-Docker suites, including the suspend / resume scenario on a real appliance), `web-vitest.txt`, `e2e-playwright.txt`; screenshots in [`module-14/screenshots/`](module-14/screenshots).

| Suite | Command | Result | Evidence |
|---|---|---|---|
| Edge appliance (Go 1.25, in Docker) | `gofmt -l . ; go vet ./... && go test -cover ./...` | **47 passed**, format and vet clean — `internal/agent`: `suspend` relayed to the worker with its reason, allow-list includes the lifecycle commands only as relays; `internal/api`: status page renders the suspension banner, the license identifier and the lifecycle; `internal/config`: `edge.json.license`. 8 packages `ok` | `edge-go-test.txt` |
| Typecheck | `pnpm typecheck` | **clean** (contracts, api, web) | `typecheck.txt` |
| Contracts (Vitest) | `packages/contracts` | **47 passed** (8 files) — license statuses and labels, create / update / action / list schemas (term order, limits), `deploymentSuspendSchema`, lifecycle-only command types excluded from the operator list | `contracts-vitest.txt` |
| API (Vitest unit + integration) | `apps/api` | **282 passed** (23 files) — `licenses.test.ts` (6): identifiers and stats, list filters and sorting, validation, RBAC and isolation, binding and capacity, readiness gate, enrollment refused under suspended / expired / revoked licenses and for suspended deployments, suspend / resume with signed commands and blocked operations, expiry sweep and reactivation, audit. `onboarding.test.ts` (18): the wizard creates the first license and binds the deployment. `edge-docker.test.ts` (16 scenarios, two real appliances): the suspended appliance records the flag, shows the banner, ignores *Sync now* for a full worker tick and runs no PSA work while heartbeats continue; packages and commands refused; after resume the pending synchronization runs. `health-rules.test.ts`: lifecycle and licensing findings. `database.test.ts`: migrations 0010 / 0011 inventory and RLS | `api-vitest.txt` |
| Web unit (Vitest) | `apps/web` | **32 passed** (5 files) | `web-vitest.txt` |
| Browser E2E (Playwright, Edge, production build) | `apps/web` | **121 passed** in 4.8m — `licenses.spec.ts`: full-page license creation with inline validation, list and filters, client card; deployment suspend / resume from the overview with a simulated agent receiving the signed `suspend` / `resume` commands, blocked operations, health and activity; license suspend / resume, viewer without controls, read-only synthetic record; onboarding wizard lists the new License ID and generates its package; accessibility (axe) and responsive sweeps include the Licenses pages; no planned placeholder in the navigation | `e2e-playwright.txt` |
| Real appliance walkthrough | `node apps/web/scripts/screenshots-m14.mjs` | one appliance installed from a package generated by the dev stack under a demo license, verified against the fake PSA; suspended from the overview with an inline confirmation (signed command executed by the real agent and worker), appliance banner and paused synchronization captured, resumed; 11 screenshots and `lifecycle-sample.json`; appliance removed | `screenshots/`, `lifecycle-sample.json` |
| Secret scan | regex over all evidence files | **0 hits** | — |
| Leftovers | `docker ps -a`, `docker volume ls` | **0** `psacc-dep-*` containers or volumes | — |

Coverage by the spec's checklist: unit (contracts schemas and labels; health rules for lifecycle and licensing; Go template rendering of the suspension banner and license; agent relay of `suspend` with its reason), API (license CRUD, identifiers, stats, list filters, validation, RBAC and isolation, binding and capacity, readiness gate, enrollment refusals for suspended / inactive licenses and suspended deployments, deployment suspend / resume with signed commands and blocked operations, expiry sweep and reactivation, audit trail; every package-generating suite now creates its own test license), database (migrations 0010 / 0011, constraints, RLS, SECURITY DEFINER functions, table inventory), integration (real appliances: suspension pauses PSA work and shows the banner while heartbeats continue; resume runs the pending synchronization), UI/E2E (full-page license creation with inline validation, list and filters, client card, deployment suspend / resume with a simulated agent receiving the signed commands, license suspend / resume, viewer and synthetic states; accessibility and responsive sweeps include the Licenses pages; no planned placeholder remains in the navigation), validation, auth (session + CSRF), tenant isolation, error handling and negative paths, security scan.

## Issues found and resolved

| # | Issue | Cause | Resolution |
|---|---|---|---|
| 1 | The dev reset refused to rebuild the synthetic organization | Tables added since Module 8 (reports, heartbeats, remote commands, licenses) were missing from its delete order | Reset order extended |
| 2 | License codes could not be generated | The per-organization sequence names were a fixed check list (`client`, `psa_instance`, `deployment`) | Migration `0011` adds `license` |
| 3 | Listing licenses sorted by end date failed (`syntax error at or near "ASC"`) | `NULLS LAST` was placed before the direction | Order clause built per field |
| 4 | Binding a license in a draft's settings was validated but not saved | The update path only asserted the license | Persisted after the version and lock checks (inside the transaction) |
| 5 | Every package-generating suite would have failed once licensing was enforced (and the seeded licenses have small limits) | The suites create many deployments per client | `ensureTestLicense()` / `ensureLicense()` helpers create a large test license per client once; the Docker, gateway, deployments and E2E flows use them |
| 6 | Audit lookups per license were not possible | The audit list had no target filters | `targetType` / `targetId` filters added to the audit list |
| 7 | A suspended appliance's health read *unknown / not enrolled* | The rules treated every lifecycle state other than enrolled / verified as not enrolled | A suspended deployment with heartbeats is evaluated like any other, with the `deployment_suspended` finding beside the measured health (unit-tested) |
| 8 | On a suspended deployment the lifecycle tracker showed *Installed & enrolled* as not done and the agent card said *Not enrolled* (screenshot review) | The web components keyed only on `enrolled` / `verified` | They use the state the deployment returns to on resume and the active certificate; the health page keeps its reports for a suspended appliance |
| 9 | In the full run, the enrollment-refusal test suspended a license the deployment was not bound to (it passed in isolation) | Once the test helper started creating a large test license per client, the deployment bound to that one instead of the test's own license | The test suspends the license the deployment is actually bound to; the API suite was rerun after this test-only fix (no product change) |
| 10 | The onboarding wizard could no longer generate the package in step 8 (the E2E wizard flow timed out on the disabled button) | A freshly onboarded client has no license, and the new readiness check gates package generation | The wizard creates the client's first license (`LIC-…`, one deployment, the contract term from step 1) with the client and binds the draft deployment to it; the License ID is listed in steps 7 and 8; API and E2E tests assert it. The API and E2E suites were rerun after the fix |

## Outstanding

- Optional cascade: suspending a license could suspend its deployments (today a deliberate per-deployment action).
- Seat- or feature-level entitlements; notifications before expiry.
- Decommissioning (Module 15) will free license capacity and complete the lifecycle.

## Next module

**Module 15 — Secure decommissioning and deployment removal** (revoke identity, wipe instructions, data retention, uninstall). Reply with the module name to proceed.
