# Module 4 Completion Report — Service Catalog

**Date:** 2026-10-15 · **Environment:** Windows 11, Docker Engine 29.1.3 (WSL), Go 1.25, Node 24.14, PostgreSQL 17, Microsoft Edge (E2E)

## Implementation status: **Complete**

**Test evidence: 463 / 463 passed** on the final code — edge Go 24 (gofmt/vet clean), contracts 39 (6 new for the catalog), API 261 in 20 files (new `services.test.ts` with 7 scenarios; both real-Docker suites, now asserting the appliance's stored service settings), web unit 32, Playwright E2E 107 (new `services.spec.ts` with 6 scenarios; `/services`, `/services/new`, `/services/categories` added to the accessibility and responsive sweeps). `pnpm typecheck` clean for all three packages.

**What works now:**
- **Catalog administration on full pages** (`/services`, `/services/new`, `/services/[id]`, `/services/[id]/edit`, `/services/categories`, `/services/categories/[id]`): create, edit (optimistic version, immutable key), activate / deactivate with inline confirmation, categories (create, rename, reorder, delete when empty), server-side filters (text, category, status, PSA use, dependency), usage counts, per-service activity from the audit log. Every row shown comes from the organization's `services` / `service_categories` tables; the defaults in code are only what a new organization starts with.
- **Configuration requirements**: a service can declare typed settings (text, number with range, yes/no, select with options, URL; required or optional) that a client must supply when the service is assigned. The same pure validator (`checkServiceConfig` in `@psacc/contracts`) runs on the client Services page, in the onboarding wizard's services step and at completion, in the deployment readiness check *Service settings complete*, and when a package is generated: the values travel in `edge.config.json` as `services[].settings` and the appliance stores them in `service_configurations.settings`. Keys or labels that look like credentials are refused — the catalog never carries secrets.
- **Integration dependencies** are a fixed vocabulary (PSA data mapped to the adapter descriptors' capabilities, or external platforms). A service that depends on PSA data must use the client's PSA (the form switches the flag on; the API refuses the inconsistent combination). The service page shows a provider support matrix; the client Services page warns when none of the client's PSA providers supports a dependency. No PSA is called.
- **Client assignment reflected in deployment configuration**: deployment pages mark services whose required settings are missing, readiness blocks package generation until they are complete, and the package carries the settings (verified in the real-Docker suite: the appliance's `service_configurations.settings` holds the values).
- **Rules that protect running clients**: deactivation keeps existing assignments and never touches appliances (only new assignments are refused); default services cannot be deactivated; categories in use cannot be deleted.

**Honest limits:**

| Area | Status |
|---|---|
| Settings on the appliance | Stored in `service_configurations.settings` and visible to the local app; nothing *acts* on them yet (ticket processing is Module 12). |
| Dependency support matrix | Derived from the adapter descriptors (vendor API capabilities), not from a live test; `psa.quotes` / `psa.projects` are "decided per provider" until the adapters model them. External platforms (RMM, M365, …) are declared, not integrated (Module 11+). |
| Catalog scope | Per organization. There is no cross-organization template or import/export. |

---

## Deliverables

| Part | Implementation |
|---|---|
| Contracts | `packages/contracts/src/services.ts`: `INTEGRATION_DEPENDENCIES`, `configRequirementSchema` (+ secret-key refusal), `checkServiceConfig()`, `serviceCreateSchema` / `serviceUpdateSchema` (PSA consistency refinement), category schemas, list query, `suggestServiceKey()`, DTOs (`ServiceSummary`, `ServiceDetail`, `ServiceCategoryDto`, `ClientServiceDto` with `config` + `configIssues`); `clientServicesUpdateSchema` and the wizard `servicesStepSchema` carry `config` per service id; `EdgeConfigV1.services[].settings`; readiness key `service_config`. |
| Database | `apps/api/migrations/0008_service_catalog.sql`: `services.created_by` / `updated_by`, lookup indexes, write grants for the application role (FORCE RLS from 0002 unchanged). Default services now seed configuration requirements (Help Desk: default priority, support hours; Patch Management: maintenance window; Microsoft 365: tenant domain; Backup: retention days — all optional). |
| API | `apps/api/src/modules/services/` (`ServicesService`, `ServicesController`): 11 routes under `services.read` / `services.write`; audit actions `service.created|updated|activated|deactivated`, `service_category.created|updated|deleted` with field-level `changes`. `ClientsService.setClientServices` validates and stores per-service settings (`serviceConfigsFor`), only *added* services must be active, audit metadata gains `configured`. Onboarding validates settings on step save and at completion. Deployments: `servicesFor` → `configComplete` + `settings`, readiness `service_config`, package input `settings`. |
| Edge | `config.go` reads `services[].settings`; `migrate.go` stores them in `service_configurations.settings` (idempotent upsert). |
| Web | `src/lib/services.ts` (grouping, dependency support, form value round-trips), `components/services/*` (badges, requirements editor, service form, status actions, category form, `ServiceConfigFields`), six pages; client Services page and the wizard's services step render requirement fields; deployment page marks incomplete settings; navigation marks Module 4 delivered (placeholder removed). |
| Seed | Synthetic clients carry values for the optional settings (some deliberately unset). |
| Docs | `ARCHITECTURE.md` §4.10, `UI_DESIGN.md` §11, README, `MODULE_PLAN.md`. |

## Security

- Backend RBAC: `services.read` (viewers, technicians, auditors, tech admins, ops admins, service managers, super admins) and `services.write` (ops admins, service managers, super admins); security admins have no catalog access. Verified by the integration suite for every role, including that read-only roles get 403 on create / update / deactivate / categories, and by E2E (no write controls, 404 on write pages).
- Tenant isolation: FORCE RLS on the catalog tables; organization B cannot read, update, delete or reference organization A's services or categories (404 / validation), and sees none of its audit events — verified through the API and through direct SQL as the application role.
- No secrets: configuration requirements refuse credential-like keys and labels; settings values are non-secret by construction and are logged only as keys in audit metadata. The evidence files were scanned: 0 hits.
- Concurrency: optimistic versions on services and categories (409 `stale-version`, "Reload latest" inline).
- Every write is audited with actor, IP and a field-level diff; activity per service includes assignment changes that involved it.

## Testing — executed results

Raw output in [`module-04/`](module-04): `edge-go-test.txt`, `typecheck.txt`, `contracts-vitest.txt`, `api-vitest.txt` (both real-Docker suites included), `web-vitest.txt`, `e2e-playwright.txt`; screenshots from the dev stack in [`module-04/screenshots/`](module-04/screenshots).

| Suite | Command | Result | Evidence |
|---|---|---|---|
| Edge agent (Go 1.25, in Docker) | `gofmt -l . && go vet ./... && go test -cover ./...` | **24 passed**, format and vet clean | `edge-go-test.txt` |
| Typecheck | `pnpm typecheck` | **clean** (contracts, api, web) | `typecheck.txt` |
| Contracts (Vitest) | `packages/contracts` | **39 passed** (6 files) — catalog schemas, `checkServiceConfig`, dependency vocabulary, key suggestion | `contracts-vitest.txt` |
| API (Vitest unit + integration) | `apps/api` | **261 passed** (20 files) incl. `services.test.ts` (list/filters, create/update/audit, assignment → readiness, deactivate/activate rules, categories, RBAC, isolation), `edge-docker.test.ts` (settings stored on two real appliances) | `api-vitest.txt` |
| Web unit (Vitest) | `apps/web` | **32 passed** (5 files) | `web-vitest.txt` |
| Browser E2E (Playwright, Edge, production build) | `apps/web` | **107 passed** in 3.9 min — catalog list/filters, create with validation, edit/deactivate/activate, client assignment with settings, categories, read-only; axe on 4 catalog pages; responsive at 375 px | `e2e-playwright.txt` |

Docker was available: nothing is marked BLOCKED. After the run no `psacc-dep-*` containers or volumes remain on the shared engine; the other stacks on it were never touched. The edge image was rebuilt (`psacc/psa-edge:0.1.0`, 5.7 MB) and re-exported; checksum in `module-04/edge-image-export.sha256`.

Coverage by the spec's checklist: unit (contracts validator and schemas, web helpers, package builder settings), API (11 routes), database (migration, RLS, constraints: default-must-be-active, category FK), integration (assignment → readiness → package → appliance `service_configurations.settings` in the Docker suite), UI/E2E (list, filters, create with validation, edit, deactivate/activate inline, categories CRUD, client assignment with settings, deployment reflection, read-only), responsive (375 px for `/services`, `/services/new`, `/services/categories`), accessibility (axe on the same pages plus the service detail), validation (secret keys, PSA consistency, select options, ranges, required settings), auth/RBAC, tenant isolation, error handling (404, 409 stale / in-use / default, 400 with field paths), negative paths, security scan.

## Issues found and resolved

| # | Issue | Cause | Resolution |
|---|---|---|---|
| 1 | Saving a client's services with an already-assigned but deactivated service was refused | `assertActiveServices` validated every selected service | Only newly added services must be active; existing assignments are kept (and the integration test covers it) |
| 2 | Catalog keys could collide with appliance expectations | Appliances store service configuration by key | The key is immutable after creation (schema and API); the form shows it read-only |
| 3 | `.next/dev/types` kept a validator for the deleted placeholder route, failing `tsc` | Next's dev type generation | Removed the stale types directory (documented gotcha) |
| 4 | Test data: the integration suite first looked for codes `CLI-00001` and a non-synthetic deployment | Seeded codes are `CL-00001`; all seeded deployments are synthetic | Tests derive the client from a real deployment list and compute readiness on synthetic deployments (only the `record` check differs) |
| 7 | axe (E2E) found three accessibility defects on the first run: settings inputs without an associated label (`select-name`), `aria-pressed` on the category tile links (`aria-allowed-attr`) and low-contrast “None” text in the dependencies column (`color-contrast`) | A per-field id override broke the label association; the tile links used a button attribute; `text-slate-400` on white | Inputs use the `Field` id again; the attribute was removed; the text uses `text-slate-500`. The a11y suite and the service detail axe check pass |
| 8 | The client Services page showed “Unsaved changes” on load | The dirty check compared two value maps built in different key orders | Both derive from the same ordered list; the save button is disabled until something changes (screenshot 08) |
| 9 | E2E expected a PSA-using service to appear on the deployment page right after assignment | The page lists PSA-using services only once they are enabled on the deployment's PSA instance (correct behaviour) | Test asserts the API detail (`requiresPsa`, `enabledOnPsa: false`, `configComplete: true`, readiness ok) and that the page keeps listing Help Desk only |
| 6 | The real-Docker suite's new assertion (appliance `service_configurations.settings` equals the package's `services[].settings`) failed on the first evidence run | The `psacc/psa-edge:0.1.0` image on the engine predated the Go change (built 2026-10-14 16:24 UTC) | Image rebuilt with `pnpm edge:build` and re-exported with `pnpm edge:export`; the suite was rerun against the rebuilt image |
| 5 | Audit count read as the schema owner returned 0 | FORCE RLS applies to the owner | The test reads as the application role with tenant context (known rule) |

## Outstanding

- Act on `service_configurations.settings` in the appliance when ticket processing arrives (Module 12).
- Model `psa.quotes` / `psa.projects` as adapter capabilities when those adapters are implemented (Module 11/12).

## Next module

**Module 11 — PSA connection testing from the appliance** (credential entry on the local admin UI, real connection test, result reported as metadata to the Control Plane), the first step of the PSA path. Alternatively Module 12 (ticket processing) only after 11.
