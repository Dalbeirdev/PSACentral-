# Module 3 Completion Report — PSA Provider & Instance Management

**Date:** 2026-10-14 · **Environment:** Windows 11, Docker Engine 29.1.3 (WSL), Node 24.14, PostgreSQL 17, Microsoft Edge (E2E)

## Implementation status: **Complete** (Module 3 scope)

**292 / 292** automated tests passed, with none skipped or blocked:

| Suite | Tests |
|---|---|
| API unit + integration | 178 |
| Contracts | 24 |
| Web unit | 23 |
| End-to-end on desktop and mobile | 67 |

All Module 1 and Module 2 tests still pass.

**Built in this module:**
- An adapter framework with one class per provider, all behind a standard `PsaAdapter` interface.
- Seven provider adapters with provider-specific configuration schemas and derived API endpoints.
- PSA instance create, list, detail and configure pages.
- Credential-status tracking that never exposes or accepts secrets.
- Enabled services per instance, and deployment association.

**No PSA API is called from the control plane, by design** (see the addendum below). Every instance shows **Untested**, with an explanation that the connection is tested only from inside the client's Docker environment. A database constraint prevents an instance from being marked verified without a test timestamp.

---

## Frontend

| Route | What it does |
|---|---|
| `/psa` | Instance directory. Provider tiles show live counts per provider; clicking one filters. Also: server-side search, filters (provider, client, connection, credentials, status), sortable columns, pagination and synthetic badges. |
| `/psa/new` | **Full-page create form**: <ul><li>An inline client search, listed in the page rather than a popup; `?clientId=` preselects the client, as the client PSA tab does.</li><li>Provider cards.</li><li>Auth-method radios and the provider's fields, rendered from the adapter descriptor. Conditional fields appear, for example *Server host name* for ConnectWise on-premise.</li><li>A live **API endpoint preview** validated by the server as you type.</li><li>A credentials panel listing the secrets that will be entered **on the appliance**, never here.</li><li>Enabled services: the client's services, with "Uses PSA" ones pre-checked.</li><li>Notes.</li></ul> |
| `/psa/[id]` | Detail page with these cards: <ul><li>Configuration, with descriptor labels and the derived endpoint.</li><li>Connection: Untested, never tested, never synced, and an explanation that only the client's appliance can test the connection.</li><li>Credentials: status plus required field names, marking which are secret.</li><li>Enabled services.</li><li>Deployment association, with "Use this instance" and an **inline confirmation**.</li><li>Adapter capabilities, with a vendor API documentation link.</li><li>Recent activity.</li></ul> |
| `/psa/[id]/configure` | Edit form: name, status (active/disabled), auth method, provider fields, services and notes. Optimistic concurrency: a stale save shows "changed by someone else" with Reload. The provider is fixed, so switching vendors means creating a new instance. |
| `/clients/[id]/psa` | Now has a working **Add PSA instance** button, and its links lead to the real detail pages. |
| Onboarding step 3 | Rebuilt on the same `PsaConfigFields` component, so the wizard and PSA Management share the same validation and endpoint preview. The free-text "API endpoint" field is gone; the adapter derives the endpoint. |

- **Navigation:** PSA Management is no longer marked *Planned*.
- **UI rules:** no modals, browser alerts or toasts; confirmations are inline.
- **Permissions:** write controls (New, Configure, Use this instance) render only with `psa.write` or `deployments.write`, and `/psa/new` returns 404 without permission.

## Backend (new endpoints, all under `/api/v1`)

| Endpoint | Permission | Notes |
|---|---|---|
| `GET /psa-providers` | `psa.read` | 7 descriptors: auth methods (labels and credential field names only), config fields, capabilities, adapter status `config_only` |
| `POST /psa-providers/:key/validate` | `psa.read` | Validates a configuration and returns the normalized config plus endpoint, or field errors. Stores nothing. |
| `GET /psa-instances` | `psa.read` | `q`, `provider`, `clientId`, `connectionStatus`, `credentialStatus`, `status`, sort and pagination. RLS-scoped, so technicians see only assigned clients. |
| `POST /psa-instances` | `psa.write` | Validated by the adapter. Starts as `credential_status=pending_appliance`, `connection_status=untested`. Audited as `psa_instance.created`. |
| `GET /psa-instances/:id` | `psa.read` | Config, notes, enabled and available services, deployments of the client (`boundHere`), creator, version |
| `PATCH /psa-instances/:id` | `psa.write` | Requires the current `version`. Rules: <ul><li>A changed endpoint or auth method resets the connection to `untested`.</li><li>Disabling while deployments use the instance → 409 `instance-in-use`.</li><li>The audit diff records per-field `from`/`to`.</li></ul> |
| `GET /psa-instances/:id/activity` | `psa.read` | Audit events for the instance |
| `PUT /deployments/:id/psa-instance` | `deployments.write` | Only an active instance of the same client. Audited as `deployment.psa_instance.changed`. |

**Adapter framework:**

| Part | Location |
|---|---|
| `PsaAdapter` interface and `BasePsaAdapter` | `apps/api/src/modules/psa/adapters/psa-adapter.ts` |
| Seven adapter classes | `adapters/providers.ts` |
| `PSA_ADAPTERS` factory token and `PsaAdapterRegistry` | `adapters/registry.ts`. The registry rejects unknown or duplicate providers. |
| Descriptors (data), shared by API and UI | `packages/contracts/src/psa/` |

- `PsaService`, onboarding completion and the seed all go through the registry. None of them branch on a provider key.
- Endpoints derived by each adapter:

| Provider | Derived endpoint |
|---|---|
| Autotask | `https://{zone}.autotask.net/ATServicesRest`, or a custom zone URL, which must be on `*.autotask.net` |
| ConnectWise | `https://api-{site}.myconnectwise.net/v4_6_release/apis/3.0`, or the on-premise host |
| HaloPSA | `{tenantUrl}/api` |
| Kaseya BMS | `https://{region}/api` |
| Freshservice | `https://{domain}/api/v2` |
| ServiceNow | `{instanceUrl}/api/now` |
| Custom REST | Base URL; a token URL is required for OAuth client credentials |

## Database — migration `0003_psa_management.sql`

- `psa_instances.status` (`active`/`disabled`, CHECK) and `psa_instances.notes`. Existing `config.notes` values were moved into the new column.
- Auth-method keys remapped to the adapter descriptors (Kaseya, ServiceNow and Custom REST) for existing rows.
- Unique instance name per client: `(client_id, lower(display_name))`. A duplicate maps to a field error on `displayName`.
- **`psa_instance_services`** holds which client services run through an instance.
  - Composite foreign keys to `psa_instances(client_id, id)` and `client_services(client_id, service_id)` make cross-client links impossible, as is enabling a service the client doesn't have.
  - FORCE RLS with client scope, and DML grants to `psacc_app_rw` only.
  - Backfill: each client's first instance gets its "Uses PSA" services.
- The migration is checksummed and applied under an advisory lock, like 0001 and 0002. Integration tests rebuild `psacc_test` from scratch on every run.

## Security

- **No PSA credentials anywhere in the control plane.**
  - Each provider's configuration schema is *strict*, so unknown keys are rejected. A `password`, `secret` or `apiKey` sent as configuration, or at the top level of the request, gets a 400: "Credentials are never stored in configuration."
  - The credentials panel only names the fields that will be entered on the appliance.
  - Tests check that API responses contain none of the smuggled values.
- **Endpoints** must be `https://` with no embedded user info. The adapter computes them, so users can't point an instance at an arbitrary URL with a typed path.
- **Honest connectivity:** control-plane adapters have no connection method and make no network calls (unit-tested with `fetch` trapped), and a database constraint requires `last_test_at` whenever the status is `succeeded`.
- **RBAC:**

  | Actor | Access |
  |---|---|
  | Read-only, technician, service manager (and auditor, for edit) | 403 on create and edit |
  | Read-only | 403 on deployment association |
  | `/psa/new` without `psa.write` | 404 |

- **Isolation:**
  - Organization B gets 404 on organization A's instances, sees only its own in lists, and cannot bind them to its deployments.
  - Technicians see only their assigned clients' instances, enforced by RLS.
- Every change is audited with `client_id`: `psa_instance.created`, `psa_instance.updated` (with field diff) and `deployment.psa_instance.changed`.

---

## Testing — executed results

Raw output: [`module-03/api-vitest.txt`](module-03/api-vitest.txt), [`contracts-vitest.txt`](module-03/contracts-vitest.txt), [`web-vitest.txt`](module-03/web-vitest.txt), [`e2e-playwright.txt`](module-03/e2e-playwright.txt), [`typecheck.txt`](module-03/typecheck.txt) (all three packages clean). Screenshots: [`module-03/screenshots/`](module-03/screenshots) (12 images). The evidence files were scanned for secrets; none were found.

| Suite | Files | Tests | Result |
|---|---|---|---|
| API unit | 3 | 57 | ✅ |
| API integration (real PostgreSQL, rebuilt per run) | 7 | 121 | ✅ |
| Contracts | 3 | 24 | ✅ |
| Web unit | 3 | 23 | ✅ |
| E2E — Edge, production build, desktop 1440px + mobile 375px | 8 | 67 | ✅ |
| **Total** | **24** | **292** | **✅ 0 failed, 0 skipped** |

### Representative Module 3 cases

| # | Category | Test | Input | Expected | Actual | ✓ |
|---|---|---|---|---|---|---|
| 1 | Unit | Registry | Catalog vs adapters; unknown key `jira`; duplicate registration | One adapter per provider; "No adapter" error; "Duplicate" error at construction | As expected | ✅ |
| 2 | Unit | Endpoint derivation, 7 providers | e.g. Autotask `webservices5`; ConnectWise `onprem` + `PSA.Acme.example` | `https://webservices5.autotask.net/ATServicesRest`; `https://psa.acme.example/v4_6_release/apis/3.0` (lower-cased) | Exact strings for all 9 cases | ✅ |
| 3 | Validation | Provider rules | Missing zone; custom zone without URL or off `autotask.net`; CW site `mars`; company ID `bad id!`; `http://` HaloPSA; HaloPSA URL with a path; OAuth Custom REST without a token URL | Error at the exact `config.<field>` path | All 13 paths | ✅ |
| 4 | Security | Credential smuggling | `config: { password }`, `{ apiKey }`; top-level `apiKey` | 400, value never echoed | As expected (unit, API, contracts) | ✅ |
| 5 | Unit | No control-plane PSA calls | All 7 adapters, with `fetch` replaced by a trap | No connection method; 0 network calls | As expected | ✅ |
| 6 | API | Providers | `GET /psa-providers` | 7 descriptors, only `config_only`, no secret values | As expected | ✅ |
| 7 | API | Validate preview | ConnectWise on-premise config | Normalized config plus endpoint; no row written | As expected (instance count unchanged) | ✅ |
| 8 | API | List | `q=Bluepeak`, `provider=connectwise`, `connectionStatus=succeeded`, `sort=client:desc`, technician caller | Server-side results; 0 "succeeded"; technician sees instances of exactly 4 assigned clients | As expected | ✅ |
| 9 | API | Create | HaloPSA instance, OAuth client credentials, `tenantUrl` only | 201: `PSA-nnnnn`, `pending_appliance`, `untested`, endpoint `…/api`, default `scope: all` applied, audit `psa_instance.created`. A second name differing only in case → 400 at `displayName` | As expected | ✅ |
| 10 | RBAC | Create; edit; bind | Read-only, technician, service manager create; the same plus auditor edit; read-only binds | 403, and nothing changes | 403 for each | ✅ |
| 11 | Validation | Create errors | Zone `webservices99`; auth `basic` for Autotask; `config.secret`; unknown client ID; a service not assigned to the client; provider `zendesk` | 400 at `config.zone`, `authMethod`, "Credentials are never stored", `clientId`, `enabledServiceIds`; 400 | As expected | ✅ |
| 12 | Concurrency | Stale version | Second PATCH reusing the pre-update `version` | 409 | 409 | ✅ |
| 13 | Business rules | Endpoint change | ConnectWise site `na` → `eu` | Endpoint `https://api-eu.myconnectwise.net/v4_6_release/apis/3.0`; connection `untested`; audit diff `config.site` `na`→`eu` and the new `apiEndpoint` | As expected | ✅ |
| 14 | Database | Honest status constraint | As the application role: `UPDATE psa_instances SET connection_status='succeeded'` with no test time | CHECK `psa_instances_verified_requires_test` violation | Rejected | ✅ |
| 15 | Integration | Deployment association | Move a Meridian deployment ConnectWise → ServiceNow; then to another client's instance; then to a disabled instance | Moved, audit `deployment.psa_instance.changed` from/to codes; 400; 400 "Disabled…" | As expected | ✅ |
| 16 | Business rules | Disable an in-use instance | `status: 'disabled'` while bound; again after moving the deployment away | 409 `instance-in-use`; then 200 | As expected | ✅ |
| 17 | Tenant isolation | Cross-organization | Org B reads org A's instance; lists; binds org A's instance to its own deployment; app role reads `psa_instance_services` without context | 404; only its own instance; 400; 0 rows | As expected | ✅ |
| 18 | Integration | Onboarding uses the adapter | Test Client A wizard with `config: { zone }`; smuggled secret in step 3 | Instance endpoint derived; Help Desk enabled on the instance; secret refused | As expected | ✅ |
| 19 | Contracts | Schema builder | Defaults, number coercion, `showWhen`, ranges, patterns, https, unknown keys | Correct output and issue paths | As expected | ✅ |
| 20 | Web unit | Form round-trip | Stored config → form values → provider schema, 6 providers | Identical config back; unknown keys dropped | As expected | ✅ |
| 21 | E2E | Create from a client's PSA tab | Lumen Pediatrics → Add PSA instance → ConnectWise on-premise; bad company ID; missing host; then valid | Inline field errors; live endpoint preview; detail shows Untested, Pending on appliance and no "Test connection" control and the appliance-only explanation | As expected | ✅ |
| 22 | E2E | Configure | Change zone; then a concurrent API edit before saving | Endpoint preview updates; saved and `psa_instance.updated` in activity; then "changed by someone else" | As expected | ✅ |
| 23 | E2E | Deployment association | "Use this instance" → inline "Yes, move" | Row shows "Uses this instance" | As expected | ✅ |
| 24 | E2E | Filters | HaloPSA tile; Connection = Verified | Only HaloPSA rows; "No PSA instances match" (nothing is verified) | As expected | ✅ |
| 25 | E2E RBAC | Read-only user | `/psa`, detail, `/psa/new` | No New, Configure or Use controls; 404 | As expected | ✅ |
| 26 | E2E | Onboarding step 3 | Save without zone; choose `webservices5` | "Web services zone is required."; preview shows `https://webservices5.autotask.net/ATServicesRest`; wizard completes | As expected | ✅ |
| 27 | Accessibility | axe WCAG 2.1 AA | `/psa`, `/psa/new`, detail, configure (and every Module 1–2 page) | 0 serious or critical | 0 | ✅ |
| 28 | Responsive | 375px | `/psa`, `/psa/new`, detail, configure | No horizontal scroll | As expected | ✅ |
| 29 | Negative (global) | Every E2E test | — | No dialogs, uncaught errors or console errors | None | ✅ |

**Docker:** Module 3 has no container-level tests. Edge containers start in Module 6, and the full Docker E2E is Module 10. Nothing is marked BLOCKED.

## Issues found and resolved

| # | Issue | Cause | Resolution |
|---|---|---|---|
| 1 | Users typed the PSA endpoint free-hand in Module 2, so a wrong host or path was possible | No provider knowledge | Endpoints are now derived by each adapter from provider fields (zone, site, tenant URL …) |
| 2 | Seeded and Module 2 rows used auth-method keys that don't match the vendors (e.g. Kaseya `api_token`) | Placeholder catalog | Migration 0003 remaps them; descriptors are the single source |
| 3 | `notes` lived inside `config`, so strict config schemas would reject existing rows | Module 2 shape | Moved to a column in 0003 |
| 4 | Stale `.next/types` referenced the deleted `/psa` placeholder route | Generated types cache | Cleared; the build regenerates them |
| 5 | Review step still referenced the removed `apiEndpoint` | Contract change | Review shows the auth method and descriptor-labelled config rows |
| 6 | PSA list name column wrapped badly at 1440px | Badge placed beside a long name | Synthetic badge moved to the code line; min width on the column |
| 7 | Detail showed "ServiceNow (ServiceNow)" | Vendor equal to product name | Vendor shown only when it differs |
| 8 | `screenshots-m2.mjs` still posted `apiEndpoint` | Contract change | Updated to `config: { zone }` |
| 9 | 3 test-side issues | Obsolete contracts assertion, a Kaseya instance picked for an Autotask edit, an ambiguous "Private key" locator | Fixed in the tests; no product change |

## Outstanding (preserved backlog)

- **Module 11:** real authentication and API connection tests per adapter (Autotask and ConnectWise first, ported from the desk-portal connectors), credential entry on the appliance, and updating `credential_status`/`connection_status` from real results.
- **Module 12:** synchronization. The capability flags shown today describe the vendor APIs, not implemented sync.
- **Module 4:** service catalog administration. Enabled services per instance already use the client's assigned services.
- **Module 5:** creating deployments for an existing client. Association works for existing deployments.
- **Not in this module:** deleting PSA instances (disable instead, which keeps the audit trail); OAuth consent flows (these happen on the appliance).
- Cross-cutting items are unchanged: SEC-OIDC, SEC-KMS, OBS-OTEL, OPS-REGISTRY, OPS-IMGEXPORT, DOC-BACKUP, TEST-LOAD and the custom-role editor UI.

## Addendum — client-hosted data-plane clarification (2026-10-14)

This mandatory clarification was received after the module was completed: the operational PSA application runs entirely inside each client's Docker deployment, and the Control Plane is a management plane only. It was applied as follows:

- **Code:**
  - The control-plane `PsaAdapter` no longer has a `testConnection()` method. It is configuration metadata only: schema, validation and endpoint derivation.
  - A unit test fails if any adapter gains a connection method or makes a network call.
  - The PSA detail page no longer shows a "Test connection" control. It explains that the connection is tested only from the client's appliance.
- **Docs:**
  - ARCHITECTURE adds AD-11 (client-hosted data plane), AD-12 (allow-listed telemetry) and AD-13 (edge autonomy during outages).
  - It also adds §1.1, covering responsibilities, the 10 required edge capabilities, the data boundary, isolation, outage behaviour and the first milestone.
  - MODULE_PLAN Modules 6 and 8–12 carry the new requirements. REUSE_ASSESSMENT makes any future ticket transfer an explicit per-client opt-in.
- **Re-verified** after the change: 292/292 (API 178, contracts 24, web 23, E2E 67), typecheck clean, evidence and screenshots refreshed.

Nothing built in Modules 1–3 stores tickets, attachments or PSA credentials, or calls a PSA API. No data migration was needed.

## Next module

**Module 4 — Service catalog:**
- Administration pages for the database-driven catalog: create and edit services and categories, activate/deactivate, and mark defaults (Help Desk stays the default).
- Configuration requirements and integration dependencies (for example "Uses PSA"), and client assignment rules, with audit and RBAC.
