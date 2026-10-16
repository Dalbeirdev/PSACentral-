# Module 2 Completion Report — Client Management & Onboarding

**Date:** 2026-10-14 · **Environment:** Windows 11, Docker Engine 29.1.3 (WSL), Node 24.14, PostgreSQL 17, Microsoft Edge (E2E)

## Implementation status: **Complete** (Module 2 scope)

**233 / 233** automated tests passed, with none skipped or blocked:

| Suite | Tests |
|---|---|
| API unit + integration | 138 |
| Contracts | 17 |
| Web unit | 20 |
| End-to-end on desktop and mobile | 58 |

All Module 1 tests still pass. The onboarding wizard runs all 10 steps end-to-end. Steps 8–10 deliberately report "not generated" and "not enrolled", because package generation (Module 5) and agent enrollment (Module 7) do not exist yet. The pages show the real database state rather than implying an installation.

---

## Frontend

| Route | What it does |
|---|---|
| `/clients` | Client directory. Server-side search over name, legal name, reference, code and city. Filters: status, service status, PSA provider, deployment health, country, account manager. Sortable columns, pagination, a deployment health bar per client, synthetic badges. An "onboardings in progress" strip appears for users who can write. |
| `/clients/new` | Start an onboarding, or resume and abandon (with an inline confirmation) drafts shared across the organization |
| `/clients/new/[draftId]/[step]` | **Full-page 10-step wizard** with one URL per step and a vertical stepper (a compact progress bar on mobile). Steps unlock in order, later steps are server-guarded, and each step is saved to the server on Continue or "Save draft and exit". |
| ↳ 1 Client information | Company, location, management and a repeatable contacts block (exactly one primary). Inline errors re-validate as you type after the first attempt. A live duplicate check shows whether the reference is free and lists similarly named clients. |
| ↳ 2 PSA provider | Radio cards for the 7 providers. Each card states its adapter status honestly ("planned (Module 3)"). Changing the provider clears step 3. |
| ↳ 3 PSA configuration | Instance name, https-only API endpoint and the provider's authentication methods. Credentials are explicitly not collected; they are entered on the appliance. |
| ↳ 4 Services | The catalog grouped by category. **Help Desk is pre-selected.** "Default" and "Uses PSA" markers. |
| ↳ 5 Deployment preferences | The 6 environments, host OS (fixed for the Windows and Linux Docker hosts), CPU architecture and host label. Shows a note about Linux containers on Windows. |
| ↳ 6 Review | Every section with Edit links back to its step. Other answers are kept. |
| ↳ 7 Create | An inline confirmation listing what is **created now** and what is **not created yet**. Creation is atomic, and users without the required permissions see why the button is disabled. |
| ↳ 8 Download | "Package not generated" (Module 5), the lifecycle tracker, and identifiers marked created or pending |
| ↳ 9 Verify | Live checklist: downloaded / enrolled / first heartbeat / database verified. Nothing turns green unless the agent reports it. Refresh button. |
| ↳ 10 Complete | Created versus pending summary, then a hand-off to the client pages |
| `/clients/[id]` | Overview: company, management (with a contract-ending badge), primary contact, counts, deployment health, assigned technicians, recent activity |
| `/clients/[id]/edit` | Full-page edit of every field. **Optimistic concurrency**: a stale edit shows "changed by someone else" with a Reload button instead of overwriting. |
| `/clients/[id]/contacts`, `/contacts/new`, `/contacts/[contactId]` | Multiple contacts with role badges. Add and edit on full pages. Removal uses an inline confirmation. |
| `/clients/[id]/services` | Assign or unassign catalog services, with an unsaved-changes hint |
| `/clients/[id]/psa`, `/deployments`, `/health`, `/activity` | PSA instances (credential and connection status, "Untested"), deployments (lifecycle and health), health summary and 30-day event timeline (labelled synthetic), and the paginated audit history for the client |
| `/settings/users/[id]` | **Client assignments** editor for technicians (filterable checkbox list). This was outstanding from Module 1. |

## Backend (new endpoints, all under `/api/v1`)

| Endpoint | Permission | Notes |
|---|---|---|
| `GET /clients` | `clients.read` | Search, 6 filters, whitelisted sort, pagination, scoped by RLS |
| `GET /clients/duplicate-check` | `clients.write` | Reference availability across the organization, plus trigram similarity on names |
| `GET /clients/:id` · `PATCH /clients/:id` | read · `clients.write` | PATCH requires `version`. It audits a field-level diff; note text is never copied into the audit trail. |
| `GET/POST /clients/:id/contacts` · `PUT/DELETE /clients/:id/contacts/:cid` | read · write | Single-primary rule with automatic demotion. The primary contact and the last contact cannot be removed. Duplicate email → 409. |
| `GET/PUT /clients/:id/services` | read · write | Active catalog services only |
| `GET /clients/:id/psa-instances` · `/deployments` · `/health` · `/activity` | `clients.read` plus `psa.read` / `deployments.read` / `health.read` | No credentials in any response |
| `GET /services` · `/psa-providers` · `/directory/users` | `services.read` · `psa.read` · `clients.read` | |
| `POST /onboarding/drafts` · `GET /onboarding/drafts[?status]` · `GET /onboarding/drafts/:id` | `clients.write` | Drafts are shared within the organization |
| `PUT /onboarding/drafts/:id/steps/:step` | `clients.write` | Zod validation plus database rules (reference uniqueness, active users, provider auth methods, active services). Version check. |
| `POST /onboarding/drafts/:id/abandon` | `clients.write` | Draft is kept for the audit trail |
| `POST /onboarding/drafts/:id/complete` | `clients.write` + `psa.write` + `deployments.write` | **One transaction** creating the client, contacts, PSA instance (untested, credentials pending on the appliance), services and a deployment in the `draft` state. Idempotent; refuses duplicate references. |
| `PUT /users/:id/client-assignments` | `users.manage` | Takes effect immediately through RLS |

## Database — migration `0002_clients_onboarding.sql`

**New tables:**
- `client_contacts`: a generated `is_primary` column, a unique partial index enforcing one primary per client, and a unique `(client_id, email)` index.
- `service_categories` and `services`: per organization, with category and organization composite foreign keys. A default service must be active.
- `client_services`: composite foreign keys to both the client and the service within the same organization.
- `onboarding_drafts`: bounded JSONB data, step checks, version, and a constraint that a completed draft must have a client, result and timestamp.

**Changed:**
- `deployments.host_label` column.
- Indexes: client activity (`audit_events (organization_id, client_id, occurred_at)`), client status, client country.

**RLS:**
- Every new table is FORCE-RLS with organization scope.
- Contacts and client services also enforce the technician client scope.
- The app role is read-only on the catalog until Module 4's admin API.

**Reference data:** every organization receives the 18-service default catalog. Only missing keys are inserted, so administrators' changes are never overwritten.

**Seed:** 61 synthetic contacts and service assignments for the 26 synthetic clients.

## Security

- Writes need `clients.write`. Completing an onboarding also needs `psa.write` and `deployments.write`, because it creates those records. A Service Manager can prepare a draft, and an Operations Administrator finishes it.
- Isolation is verified both through the API and directly in SQL as the application role: organization B gets 404 on organization A's clients, contacts, services and drafts. Technicians are limited to assigned clients in SQL as well as in the UI.
- PSA credentials are never accepted (the step schema is strict, so a `password` field is rejected), stored or returned. API endpoints must be `https://` with no embedded credentials.
- Client-reference uniqueness is enforced organization-wide inside the RLS boundary; only the conflicting client's code is revealed.
- Optimistic concurrency on client updates and draft steps prevents silent lost updates.
- Every change is audited with `client_id`: client updates and status changes, contacts, services, onboarding drafts, `client.onboarded`, `psa_instance.created`, `deployment.created` and assignments. Audit events are ordered by `clock_timestamp()`.
- The dev-only `seed --reset` must lift FORCE RLS on `audit_events` inside its transaction, because even the schema owner cannot delete audit rows. That confirms the append-only design holds at the owner level too.

---

## Testing — executed results

Raw output: [`module-02/api-vitest.txt`](module-02/api-vitest.txt), [`contracts-vitest.txt`](module-02/contracts-vitest.txt), [`web-vitest.txt`](module-02/web-vitest.txt), [`e2e-playwright.txt`](module-02/e2e-playwright.txt), [`typecheck.txt`](module-02/typecheck.txt). Screenshots: [`module-02/screenshots/`](module-02/screenshots) (15 images, including every wizard data step).

| Suite | Files | Tests | Result |
|---|---|---|---|
| API unit | 2 | 29 | ✅ |
| API integration (real PostgreSQL, rebuilt per run) | 6 | 109 | ✅ |
| Contracts | 2 | 17 | ✅ |
| Web unit | 2 | 20 | ✅ |
| E2E — Edge, production build, desktop 1440px + mobile 375px | 8 | 58 | ✅ |
| **Total** | **20** | **233** | **✅ 0 failed, 0 skipped** |

### Representative Module 2 cases

| # | Category | Test | Input | Expected | Actual | ✓ |
|---|---|---|---|---|---|---|
| 1 | API | Directory search, filter, sort, paginate | `q`, `status=suspended`, `country=GB&provider=connectwise`, `health=critical`, `sort=code:asc`, page 2 | Server-side results | Exact expected names and codes | ✅ |
| 2 | Input validation | Bad list params | `status=deleted`, `country=gb`, SQL-like sort, `pageSize=500` | 400 | 400 ×4 | ✅ |
| 3 | RBAC | Read-only, technician and auditor PATCH | Valid payload | 403 | 403 ×3 | ✅ |
| 4 | Tenant isolation | Technician direct access | Unassigned client ID | 404 | 404 (client and contacts) | ✅ |
| 5 | Database | Update with diff | City and status change | 200; audit `client.status.changed` with from/to; note content not copied | As expected | ✅ |
| 6 | Concurrency | Stale version | Second PATCH with the old version | 409 `stale-version` | 409 | ✅ |
| 7 | Validation | Duplicate reference | `acct-1040` (case differs) | 400 "already used by CL-00001" | As expected; duplicate check shows it unavailable and the similar name | ✅ |
| 8 | Validation | Field rules | ftp website, XX country, bad time zone, unknown business type, end before start, unknown user | 400 at each path | All 6 | ✅ |
| 9 | Business rules | Contacts | New primary; demote only primary; delete primary; duplicate email | Old primary demoted; 400; 409; 409 | As expected | ✅ |
| 10 | Tenant isolation | Contacts RLS | No context; technician context | 0 rows; 4 clients | As expected | ✅ |
| 11 | API | Services | Catalog; assign; org B's service ID; unknown ID | 18 with Help Desk default; audited; 400; 400 | As expected | ✅ |
| 12 | RBAC | Technician assignments | Assign 2 clients; unknown client; tech admin attempts | Visible immediately; 422; 403 | As expected | ✅ |
| 13 | Security | Last Super Administrator | Custom role with `roles.manage` disables or demotes the only SA | 409 `last-super-admin`; allowed once a second SA exists | As expected (closes the Module 1 gap) | ✅ |
| 14 | RBAC | Onboarding permissions | Read-only, technician, auditor, tech admin start a draft; service manager completes | 403; 403 | As expected; ops admin completes the shared draft | ✅ |
| 15 | Database | Draft persistence | Save step 1, new session | Same data and version; next step = PSA provider | As expected | ✅ |
| 16 | Validation | Step errors with paths | Bad website, no primary, duplicate contact email | Paths `company.website`, `contacts`, `contacts.1.email` | As expected | ✅ |
| 17 | Concurrency | Two tabs | Same draft version twice | 2nd → 409 | 409 | ✅ |
| 18 | Business rules | Step order and provider rules | PSA config before provider; wrong auth method; `http://user:pass@`; provider change | 409; 400; 400; config cleared | As expected | ✅ |
| 19 | Integration | **Test Client A** (Autotask; Help Desk + Endpoint Mgmt) | Full draft → complete | CL/PSA/DEP codes; untested PSA with credentials pending on the appliance; 2 services; deployment `draft`/`unknown`; 3 audit events in order | As expected | ✅ |
| 20 | Integration | **Test Client B** (ConnectWise; Help Desk + Security Monitoring) | Full draft → complete | Independent client, deployment and code | As expected | ✅ |
| 21 | Idempotency | Double completion, then edit | Complete ×2; save step | Same result, one client; 409 `draft-closed` | As expected | ✅ |
| 22 | Negative | Duplicate-reference race | Two drafts, same reference | 2nd completion 409; no partial records | As expected | ✅ |
| 23 | Tenant isolation | Drafts across organizations | Org B reads or saves org A's draft | 404; empty list; RLS 0 rows | As expected | ✅ |
| 24 | E2E | Full wizard in the browser | All 10 steps, with validation errors, live duplicate detection, a review edit round-trip and inline confirmation | Client page shows the new real (non-synthetic) record | As expected | ✅ |
| 25 | E2E | Resume across devices | Save and exit, new browser context | Resumes at step 2 with step 1 data; locked step redirects | As expected | ✅ |
| 26 | E2E | Concurrent edit | API changes the client while the form is open | "changed by someone else" plus Reload | As expected | ✅ |
| 27 | E2E | Contacts, services, assignments, all client tabs | UI flows | Inline confirmations; saved state shown; technician scope changes live | As expected | ✅ |
| 28 | Accessibility | axe WCAG 2.1 AA | Directory, onboarding start, 9 client pages, wizard step 1 | 0 serious or critical | 0 | ✅ |
| 29 | Responsive | 375px | Directory, onboarding start, overview, contacts, edit, wizard | No horizontal scroll | As expected | ✅ |
| 30 | Negative (global) | Every E2E test | — | No dialogs, uncaught errors or console errors | None | ✅ |

## Issues found and resolved

| # | Issue | Cause | Resolution |
|---|---|---|---|
| 1 | Duplicate check returned 500 | `similarity()` cannot be used with `ANY()` | Rewrote it with `unnest` and a lateral `max(similarity)` |
| 2 | Client activity listed events out of order | Audit `now()` is per transaction | The audit writer uses `clock_timestamp()` |
| 3 | Generic zod messages ("Invalid input: expected string…") | Default error map | A shared plain-language error map in contracts, used by both the UI and the API |
| 4 | Dates could shift by a day | `pg` parses `DATE` into a local-midnight JS Date | `DATE` stays a `YYYY-MM-DD` string, and the UI formats calendar dates without time zones |
| 5 | **Concurrency bug** found in self-review | The reference check stored the request's scope on a singleton service field | The scope is passed per call, so no shared state remains |
| 6 | React #418 hydration errors on forms | Node and Edge ship different ICU data, so the country and time-zone option lists differed | The server computes the lists and passes them as props (profile form too) |
| 7 | "Enter a client reference" persisted after typing | Errors only refreshed on submit | Live re-validation after the first attempt |
| 8 | Success message vanished after saving assignments or services | A `key` tied to saved data forced a remount on refresh | Removed the remount keys |
| 9 | `invalid` attribute warning on `<textarea>` | The Field render prop leaked onto a raw element | Added a `Textarea` component |
| 10 | Dev reset failed on `audit_events` | Append-only even for the owner (expected) | The reset lifts FORCE RLS inside its transaction and restores it |
| 11 | Mobile overview stacked the 4 count tiles one per row | Grid breakpoint | Two per row on mobile |
| 12 | 4 test-side issues | FORCE-RLS reads as owner, a password containing the email name, an ambiguous label, an exact link name | Fixed in the tests; no product change |

## Outstanding (preserved backlog)

- **Module 3:** PSA management pages (`/psa`, `/psa/new`, `/psa/[id]`, `/psa/[id]/configure`), the `PsaAdapter` interface with provider config schemas, and adding a PSA instance to an existing client. Client PSA tab links lead to the honest planned page until then.
- **Module 4:** service catalog administration (create, edit, activate/deactivate, defaults, categories, config requirements, integration dependencies). The catalog is already database-driven and assignable.
- **Module 5:** package generation, enrollment tokens and installation IDs, which wizard steps 8–9 are waiting on. Also adding a deployment to an existing client.
- **Not in this module:** creating a client without the wizard (by design, the wizard is the single creation path); bulk import; contact deduplication across clients.
- Cross-cutting items are unchanged: SEC-OIDC, SEC-KMS, OBS-OTEL, OPS-REGISTRY, OPS-IMGEXPORT, DOC-BACKUP, TEST-LOAD and the custom-role editor UI.

## Next module

**Module 3 — PSA provider & instance management:**
- The adapter registry and a standard `PsaAdapter` interface, modelled on desk-portal's `IServiceManagementConnector`.
- Seven provider adapters with configuration and credential schemas (no API calls yet).
- PSA management pages and instance CRUD with validation.
- Credential status without exposing secrets, plus deployment association.
