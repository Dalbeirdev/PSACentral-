# Module 1 Completion Report — Control Plane Foundation & Professional Dashboard

**Date:** 2026-10-14 · **Environment:** Windows 11 + Docker Engine 29.1.3 (WSL Ubuntu) · Node 24.14 · PostgreSQL 17 (container `psacc-dev-postgres`)

## Implementation status: **Complete** (for Module 1 scope)

All required Module 1 tests ran and passed: **158 / 158** (API 94, contracts 9, web unit 15, end-to-end 40). No test was skipped or blocked.

Docker-based appliance tests belong to Modules 6–10 and aren't part of this module. Docker Engine is available in this environment, so they won't be blocked when we reach them.

Items listed under *Outstanding* are later-module scope, or explicit backlog decisions. None of them is a Module 1 gap that has been reported as done.

---

## Frontend (`apps/web`, Next.js 16 / React 19 / Tailwind 4)

| Area | Delivered |
|---|---|
| Design system "Signal" | Pinned brand tokens (#2563EB, #06B6D4, #10B981, #8B5CF6, #F59E0B, #EF4444, #F5F8FF, #0F172A, #64748B); Inter + JetBrains Mono. Components: Button/ButtonLink, Card, Badge, HealthPill (icon + label + color), LifecycleStage, SyntheticBadge, Field/Input/Select/Checkbox with inline errors, Alert (the only notification mechanism), Table/SortTh/Pagination (server-side), EmptyState/ErrorState/Skeleton, PageHeader + Breadcrumbs, KpiCard, ChartCard with a data-table twin, BarList |
| App shell | Left sidebar with the 12 required items, grouped. Planned items carry an `M<n>` marker. Top bar: page title, global search, notifications bell (live count), environment badge, account menu. Skip link. Under 1024px the menu expands inline and never overlays content |
| Sign-in flow (full pages) | `/login`, `/login/mfa` (TOTP or recovery code), `/login/password` (forced change of temporary password), `/login/mfa-setup` (required-MFA environments). Each step page only renders for the matching session state. `?next=` is validated, which blocks open redirects |
| Dashboard `/dashboard` | 8 KPI cards: total clients, PSA instances, active, offline, healthy (with meter), critical, Docker versions, recent deployments. 5 charts: status over time (stacked area, 30 days, user's time zone), health distribution (donut + labeled legend), onboarding (12 months), PSA provider distribution, version distribution (latest emphasized). Also: a recent-deployments table, a persistent **synthetic-data banner**, per-row *Synthetic* badges with "Synthetic — not live" instead of a heartbeat time, and a Refresh button |
| Other pages | `/search` (full-page global search), `/notifications`, `/audit` (filter/sort/paginate, metadata details), `/settings` (shortcuts + live DB/migration/security-policy status), `/settings/profile` (name + preferred time zone), `/settings/security` (MFA enroll/disable, password change), `/settings/users`, `/settings/users/new`, `/settings/users/[id]` (roles, inline confirmation to disable), `/settings/roles` (role cards + permission matrix), 404 page, error boundary, dashboard skeleton |
| Planned modules | `/clients`, `/psa`, `/services`, `/deployments`, `/docker-images`, `/database-explorer`, `/monitoring`, `/integrations`, `/licenses`, including deep links. Each shows an honest "Planned · Module N" page listing its scope, with **no functional controls** |
| No pop-ups | No modals, `alert()`, `confirm()` or toasts. Confirmations are inline sections. E2E fixtures fail any test that opens a browser dialog |

## Backend (`apps/api`, NestJS 12 ESM)

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /api/v1/health/live`, `/health/ready` | public | Liveness. Readiness checks the DB and that no migrations are pending (503 otherwise) |
| `GET /api/v1/system/info` | public | Environment badge (name, env, version, MFA policy) |
| `GET /api/v1/system/status` | `settings.read` | DB server, size, migrations, effective security policy |
| `POST /auth/login`, `/auth/mfa/verify`, `/auth/password`, `/auth/mfa/enroll/start`, `/auth/mfa/enroll/confirm`, `/auth/mfa/disable`, `/auth/logout`; `GET /auth/me`; `PATCH /auth/profile` | session state machine | Sign-in, MFA, password, profile |
| `GET/POST /users`, `GET/PATCH /users/:id` | `users.read` / `users.manage` | User admin with escalation guards |
| `GET /roles`, `/permissions` | `roles.read` | RBAC catalog |
| `GET /audit-events` | `audit.read` | Audit search |
| `GET /dashboard/summary` | `dashboard.read` | KPIs, chart series, provenance |
| `GET /search`, `/notifications` | authenticated (results filtered by permission) | Global search, notifications |

Cross-cutting pieces:
- Zod validation shared with the UI; unknown fields are rejected.
- RFC 9457 problem+json errors with request IDs.
- Structured JSON logs with secret masking.
- helmet, plus `Cache-Control: no-store` and body-size limits.
- Per-IP rate limits.
- OpenAPI 3 at `/api/docs` (21 paths, dev only).

## Database (migration `0001_foundation.sql`)

**Tables:**
- Identity: `organizations`, `organization_sequences`, `users`, `sessions`, `user_recovery_codes`
- RBAC: `permissions`, `roles`, `role_permissions`, `user_roles`, `user_client_assignments`
- Operations: `clients`, `psa_providers`, `psa_instances`, `deployments`, `deployment_health_events`
- Audit and migrations: `audit_events`, `schema_migrations`

**Constraints & indexes:**
- Composite foreign keys keep every relation inside one organization.
- A deployment's PSA instance must belong to the same client.
- Client references are unique per organization, case-insensitively.
- "Honesty" checks: PSA `connection_status='succeeded'` requires `last_successful_test_at`; deployment health ≠ `unknown` requires `enrolled_at`; lifecycle stages require their timestamps; contract end ≥ start.
- Trigram indexes support search, and time-ordered indexes support the dashboard and audit queries.

**Security in the schema:**
- RLS on every tenant table, failing closed when no context is set. Client-scope RLS (`app_can_access_client`) restricts technicians.
- Two `SECURITY DEFINER` auth functions with a pinned `search_path`.
- The app role has DML only; `audit_events` and `deployment_health_events` are INSERT/SELECT only.

**Migrator:**
- Checksummed migrations under an advisory lock, one transaction per migration.
- Refuses to run if an applied file was modified.
- Idempotent reference-data sync (permissions, 8 system roles, 7 PSA providers).

**Seed:** synthetic, deterministic, every row flagged `is_synthetic`, refused outside dev/test.

## Security

- **Authentication**
  - scrypt (N = 2¹⁷).
  - Generic errors, and a dummy hash for unknown accounts so timing doesn't reveal which accounts exist.
  - Lockout after 5 failures for 15 minutes; per-IP login rate limit.
  - TOTP MFA (RFC 6238) with replay protection, 10 hashed one-time recovery codes, and session revocation after 5 bad codes.
  - MFA-required mode, enforced in staging/production.
  - Admin-created users receive a temporary password and must change it.
  - OIDC-ready user model.
- **Sessions**
  - Opaque 256-bit tokens; only the SHA-256 hash is stored.
  - Idle (30 min) and absolute (12 h) expiry.
  - Rotation on every sign-in state change (prevents fixation).
  - Other sessions are revoked on password change, MFA enrollment, role change or account disable.
  - Cookies: `HttpOnly; SameSite=Lax`, plus `Secure` and the `__Host-` prefix over HTTPS.
- **CSRF:** HMAC-bound double-submit token plus an Origin allow-list on every unsafe request.
- **Authorization**
  - Default-deny guard; a unit test asserts every route declares its access.
  - 8 configurable roles. Technicians see only assigned clients, enforced in SQL.
  - Escalation guards: only `roles.manage` holders can grant or modify Super Administrator, and nobody can change their own roles or status (both covered by tests). The last active Super Administrator is also protected; that guard is implemented but not yet covered by an automated test, which is added in Module 2.
  - Denials are audited.
- **Isolation:** organization RLS plus client-scope RLS, proven by unfiltered-query tests as the application role.
- **Secrets**
  - AES-256-GCM envelopes bound to their row via associated data.
  - No secrets in API responses or logs.
  - Generated `.env` files are git-ignored.
  - Boot-time guards refuse unsafe staging/production configuration.
- **Web headers:** per-request nonce CSP with `strict-dynamic`, `frame-ancestors 'none'`, nosniff, `X-Frame-Options`, Referrer-Policy, Permissions-Policy, COOP, and HSTS in production.

---

## Testing — executed results

Raw output: [`module-01/api-vitest.txt`](module-01/api-vitest.txt), [`module-01/contracts-vitest.txt`](module-01/contracts-vitest.txt), [`module-01/web-vitest.txt`](module-01/web-vitest.txt), [`module-01/e2e-playwright.txt`](module-01/e2e-playwright.txt). Screenshots: [`module-01/screenshots/`](module-01/screenshots).

| Suite | Files | Tests | Result | Duration |
|---|---|---|---|---|
| API unit (vitest) | 2 | 29 | ✅ 29 passed | ~1.5 s |
| API integration (vitest, real PostgreSQL `psacc_test`, rebuilt per run) | 4 | 65 | ✅ 65 passed | ~65 s |
| Contracts unit | 1 | 9 | ✅ 9 passed | 0.3 s |
| Web unit | 1 | 15 | ✅ 15 passed | 0.3 s |
| E2E (Playwright, Edge; production build; `psacc_e2e`; desktop 1440px + mobile 375px) | 6 | 40 | ✅ 40 passed | ~1.6 min |
| **Total** | **14** | **158** | **✅ 158 passed, 0 failed, 0 skipped** | |

### Representative cases (by required test category)

| # | Category | Test | Input | Expected | Actual | Status |
|---|---|---|---|---|---|---|
| 1 | Unit | TOTP RFC 6238 vectors | 6 official T values, 8 digits | Published codes | All 6 match (plus 10 RFC 4226 HOTP vectors) | ✅ |
| 2 | Unit | SecretBox tamper / wrong-row | Modified ciphertext; different associated data | Decrypt throws | Throws | ✅ |
| 3 | Unit | Default-deny audit | All controller routes | Every route declares access; only login, health and info are public | 0 undeclared; public = exactly 4 | ✅ |
| 4 | Unit | Production config guards | MFA off / http origin / owner DB user | Boot refused | `ConfigError` for each | ✅ |
| 5 | API | Unauthenticated access | `GET /dashboard/summary`, no cookie | 401 problem+json | 401, `urn:psacc:problem:unauthenticated`, requestId | ✅ |
| 6 | Authentication | Generic login failure | Wrong password vs unknown email | Identical 401 messages, no cookie | Identical; no cookie | ✅ |
| 7 | Authentication | Session cookie flags & storage | Valid login | HttpOnly + SameSite=Lax; DB holds only SHA-256 | Verified via header + DB lookup | ✅ |
| 8 | Security | Lockout | 5 wrong, then correct password | 401, locked, audited | 401; `locked_until` set; `auth.login.locked` event | ✅ |
| 9 | Security | CSRF | No token / other session's token / foreign Origin | 403 | 403 `csrf-token` / 403 / 403 `csrf-origin` | ✅ |
| 10 | Security | Rate limit | 5 logins at limit 3/min | 401 ×3, then 429 | `[401,401,401,429,429]` | ✅ |
| 11 | Authentication | MFA enrollment | Bad code, then valid TOTP | 400 (audited), then 10 recovery codes; session rotated; secret encrypted | As expected; old cookie → 401; `v1.` envelope | ✅ |
| 12 | Security | TOTP replay & recovery reuse | Same code twice; same recovery code twice | 2nd attempt rejected | 400 on reuse | ✅ |
| 13 | Authentication | Forced password change | Temp password login → dashboard → weak/strong new password | 403 → 422 → active | As expected; temp password then invalid | ✅ |
| 14 | RBAC | Role matrix | 12 role/endpoint pairs | 403/200 per matrix | All match | ✅ |
| 15 | RBAC | Read-only cannot change | `POST /users` as read_only/auditor | 403 + audited `access.denied` | 403; audit event present | ✅ |
| 16 | RBAC | Escalation | Ops admin grants super_admin / edits super admin; self role change | 403 | 403 ×3 (`self-modification` type) | ✅ |
| 17 | Tenant isolation | Org A vs org B via API | Search "Zephyr", `GET /users/:orgB`, dashboard | Nothing from B | 0 results, 404, counts unchanged (26 vs 1) | ✅ |
| 18 | Tenant isolation | RLS, no context | `SELECT count(*)` on 9 tenant tables as `psacc_app` | 0 rows each | 0 for all | ✅ |
| 19 | Tenant isolation | Cross-tenant writes | INSERT into org B / UPDATE / DELETE under org A context | Blocked | RLS violation; 0 rows affected | ✅ |
| 20 | Tenant isolation | Technician scope in SQL | Technician context | 4 clients; no unassigned deployments | 4; 0 | ✅ |
| 21 | Database | Migration idempotency & tamper | Re-run; altered checksum | 0 applied; refuse | 0 applied; "checksum mismatch" | ✅ |
| 22 | Database | Least privilege | CREATE TABLE, DISABLE RLS, SET ROLE owner, UPDATE/DELETE/TRUNCATE audit | Denied | permission denied / must be owner | ✅ |
| 23 | Database | Honesty constraints | Health without enrollment; PSA "succeeded" without test; cross-client PSA binding | Rejected | Named constraint violations | ✅ |
| 24 | Input validation | Bad payloads | Invalid email, unknown role, duplicate email, bad UUID, SQL-ish sort | 400/422/409/400/400 | As expected | ✅ |
| 25 | UI / E2E | KPIs equal API | Compare 8 KPI values with `/dashboard/summary` | Identical | Identical (26 clients, …) | ✅ |
| 26 | UI / E2E | Synthetic labeling | Recent deployments rows | Every row badged, "Synthetic — not live" | All rows | ✅ |
| 27 | UI / E2E | Charts + table twins | 5 chart cards | Rendered + table rows | All 5 | ✅ |
| 28 | UI / E2E | Navigation | All 12 sidebar links | Page + h1; planned pages have 0 buttons | All 12 | ✅ |
| 29 | UI / E2E | MFA end-to-end | Enroll via UI; sign in with TOTP computed by the test | Dashboard after code; wrong code inline error | As expected | ✅ |
| 30 | UI / E2E | User creation → first sign-in | Create Technician on `/settings/users/new` | Temp password shown once; forced change; scoped dashboard | As expected | ✅ |
| 31 | Error handling | Unknown route; permission-denied page | `/definitely-not-a-page`; read-only → `/audit` | HTTP 404 | 404 | ✅ |
| 32 | Security (web) | Headers | `GET /login` | Nonce CSP + strict-dynamic, frame-ancestors none, XFO DENY | Present | ✅ |
| 33 | Accessibility | axe WCAG 2.1 AA | Login + 8 app pages | 0 serious/critical | 0 | ✅ |
| 34 | Responsive | 375px | Login, dashboard, audit, users, security, planned page | No horizontal scroll; single-column KPIs; inline nav | As expected | ✅ |
| 35 | Negative (global) | Every E2E test | — | No dialog, uncaught error or console error | None | ✅ |

## Issues found during testing, and how each was resolved

| # | Issue | Cause | Resolution |
|---|---|---|---|
| 1 | API failed to boot (`ThrottlerGuard` could not resolve `Reflector`) | The dev runner (esbuild) does not emit decorator metadata | Subclassed the guard with explicit `@Inject`. The whole codebase uses explicit injection, so dev, test and build behave the same |
| 2 | Sign-in spinner never navigated | `router.replace()` followed by `router.refresh()` cancels the navigation | Sign-in state changes now do a full navigation (`navigateTo`) |
| 3 | Chart table headers empty; React key warning | Server components imported constants from a `'use client'` module and got client-reference proxies | Moved health constants into a shared `lib/health.ts` |
| 4 | `/audit` returned HTTP 200 to a read-only user (UI hidden, wrong status) | The app-wide `loading.tsx` started streaming before `notFound()` | Scoped the skeleton to the dashboard; denied pages now return a real 404 |
| 5 | axe *serious* color-contrast on 4 pages | `slate-400` small text (≈2.6:1) | Moved text uses to `slate-500`/`slate-600` (≥ 4.5:1). Icons unchanged |
| 6 | Required asterisk was part of the accessible label ("Password*") | Marker rendered as label text | Marker drawn by CSS; `aria-required` set on the control |
| 7 | Rate-limit bypass risk (found in self-review before testing) | A per-session throttle key could be rotated with random cookies on the public login | Throttling is per-IP only. The web tier forwards the client IP, and the API trusts only loopback proxies |
| 8 | Two integration tests read FORCE-RLS tables as the owner and saw 0 rows | Test bug — the RLS behavior is correct (fail-closed) | Tests read inside the organization's context, as the API does |
| 9 | `lucide-react@1.57.0` (published that day) was auto-excluded from pnpm's minimum-release-age policy | Supply-chain policy | Removed the exclusion and pinned 1.48.0 (published 2026-09-24) |

## Reuse of existing projects

A read-only survey is in [`docs/REUSE_ASSESSMENT.md`](../REUSE_ASSESSMENT.md). No existing project was modified. desk-portal's connector contract and schema, PioDesk's edge-gateway enrollment and mTLS model, and DeployHub's agent heartbeat are the references for Modules 3, 6–8 and 11–12.

## Deviations from the recommended stack (with reasons)

- **shadcn/ui:** "equivalent accessible components" were built in-repo instead of pulling Radix dependencies. They follow the same API style and are verified by axe.
- **OIDC:** the user model and the MFA state machine are OIDC-ready. Wiring an external IdP (Keycloak, already used by desk-portal, or Entra ID) is backlog item **SEC-OIDC**, to be done before production.
- **OpenTelemetry:** request IDs (traceparent-compatible header handling) and structured logs are in place. OTel export is scheduled with health monitoring (**OBS-OTEL**, Module 8).
- **Redis:** not introduced; there's no tested use case yet. The in-memory rate limiter is per-instance, and **OPS-REDIS** covers multi-instance deployment.

## Outstanding requirements (full backlog preserved in [`docs/MODULE_PLAN.md`](../MODULE_PLAN.md))

- **Module 2:** full client CRUD and all client fields in the UI; contacts; client pages; the 10-step onboarding wizard with server-side drafts; client-assignment management (technician assignments currently come from the seed).
- **Modules 3–15** as planned: PSA adapters, service catalog, deployment packages and enrollment tokens, Go edge appliance with the 8 required tables, mTLS enrollment, live health monitoring, Database Explorer, real two-client Docker tests, PSA connection testing, sync, remote management, licensing and decommissioning.
- **Cross-cutting:** SEC-OIDC, SEC-KMS (key management and rotation), OBS-OTEL, OPS-REGISTRY, OPS-IMGEXPORT, DOC-BACKUP, TEST-LOAD, custom-role editor UI (custom roles are already supported in the schema).
- **Data in Module 1:** the dashboard's clients, PSA instances, deployments and health history are **synthetic seed records**, labeled as such throughout. Real records arrive through Modules 2–8.

## Next module

**Module 2: Client management and onboarding.** It covers client CRUD with every specified field, multiple contacts, server-side search/filter/sort/pagination, the per-organization duplicate-reference guard (already enforced in the DB), the client pages (overview, edit, contacts, services, PSA, deployments, health, activity), the full-page 10-step onboarding wizard with resumable server-side drafts (Help Desk pre-selected once Module 4 lands, with a stub until then), and technician client-assignment management.
