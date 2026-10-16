# PSA Control Center — Security Architecture

## Threat model (summary)

| Asset | Threat | Primary controls |
|---|---|---|
| Operator accounts | Credential stuffing, phishing, session theft | scrypt hashing, lockout + rate limits, TOTP MFA (required in production), HttpOnly/SameSite/Secure cookies, idle + absolute timeouts, server-side revocation |
| Cross-organization data | IDOR, missing tenant filter | RLS `organization_id = app_current_org()`, fail-closed when unset, tests that run unfiltered queries |
| Client-scoped data | Technician reading unassigned clients | RLS `app_can_access_client(client_id)` + service-layer checks |
| Audit trail | Tampering after compromise | `audit_events` granted INSERT/SELECT only to the app role; no UPDATE/DELETE privilege exists |
| Secrets (MFA seeds, later PSA credential refs) | DB dump disclosure | AES-256-GCM with a key from the environment/KMS; never returned by APIs; masked in logs |
| Client edge databases | Exposure, cross-client reads | Dedicated container + volume + credentials per deployment; no published ports; metadata-only inspector role; outbound-only agent |
| Agent channel *(Module 7)* | Impersonation, token replay | Single-use, short-lived, hashed enrollment tokens; CSR-based mTLS certificates bound to deployment + installation; revocation list checked per request |
| Remote commands (Module 13) | Forged / replayed / redirected commands, destructive remote actions | Ed25519-signed commands (key pinned at enrollment) with ID, issuer, deployment + installation target, expiry; fixed non-destructive allow-list in the agent binary; executed once; results over mTLS; audited on issue, delivery, completion, expiry and cancellation. Upgrades are staged and applied on the host by the operator (no Docker socket in the appliance) |
| Decommissioning (Module 15) | Remote wipe or shutdown of a client's appliance; a retired identity still accepted; data deleted without consent; premature loss of evidence | No remote decommission / uninstall / wipe command exists (asserted); decommissioning only revokes identity material on the Control Plane and is signalled to the agent as an authenticated `decommissioned` refusal; host-side removal is a script the operator runs, which refuses to wipe an active identity without `--force` and needs the typed deployment ID; `deployments.decommission` permission, typed confirmation, final; audit of decommissioning, purge and removal is append-only and survives removal; retention purge deletes metadata only, after a policy period |
| Licensing / lifecycle (Module 14) | Packages or enrollment without entitlement; unauthorised suspension | License required (active, in term, under its limit) for package generation and enrollment; suspension needs `deployments.write`, is reversible, audited and delivered to the appliance as a signed command; license management needs `licenses.manage` |

## Identity & authentication (Module 1 — implemented)

- **Passwords:** `scrypt` (N = 2^17, r = 8, p = 1, 32-byte salt, 64-byte key), encoded `scrypt$N$r$p$salt$hash`. Policy: 12–128 characters, must not contain the email local part. Unknown-email logins still run a dummy hash, so response timing doesn't reveal which accounts exist.
- **Lockout:** 5 consecutive failures lock the account for 15 minutes (audited as `auth.login.locked`), on top of a per-IP rate limit (10 login attempts/min).
- **MFA:** TOTP (RFC 6238, SHA-1, 6 digits, 30 s, ±1 step). Seeds are encrypted with AES-256-GCM. The last accepted time-step is stored, so a code can't be replayed. Ten single-use recovery codes are stored as SHA-256 hashes and shown once.
- **MFA required mode:** `AUTH_MFA_REQUIRED=true` (mandatory in staging/production — config validation refuses to boot otherwise). Users without MFA get a `mfa_setup_required` session that can only reach the enrollment endpoints.
- **Sessions:** 32 random bytes → base64url cookie value. Only `SHA-256(token)` is stored. Session states: `mfa_pending` | `mfa_setup_required` | `active`. Idle timeout 30 min, absolute 12 h (configurable). Cookie: `HttpOnly; SameSite=Lax; Path=/`, plus `Secure` and the `__Host-` prefix outside development.
- **OIDC-ready:** `users.auth_provider` (`local` | `oidc`) and `external_subject` (unique per provider). An OIDC login module (Keycloak / Entra ID) can be added without schema changes. Planned as backlog item **SEC-OIDC**.

## CSRF (implemented)

- The token is `base64url(HMAC-SHA256(CSRF_SECRET, session.id))`, delivered in the non-HttpOnly cookie `psacc_csrf`. The browser echoes it in the `x-csrf-token` header.
- Every unsafe method (POST/PUT/PATCH/DELETE) on an authenticated route must present a matching header **and** an `Origin`/`Referer` in `APP_ALLOWED_ORIGINS`.
- Login is protected by SameSite + Origin check and rate limiting.

## Authorization (implemented)

- **Default deny:** a route without `@Public()`, `@AuthenticatedOnly()` or `@RequirePermissions(...)` returns 403. A unit test enumerates all routes and asserts each has a declaration.
- **Roles → permissions** are stored in `roles` / `role_permissions` (configurable; custom roles per organization are supported by the schema). The system roles are seeded by migration:

| Permission | Super | Ops | Tech | Technician | Svc Mgr | Security | Auditor | Read Only |
|---|---|---|---|---|---|---|---|---|
| dashboard.read | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| clients.read | ✔ | ✔ | ✔ | ✔ (assigned) | ✔ | ✔ | ✔ | ✔ |
| clients.write | ✔ | ✔ | | | ✔ | | | |
| psa.read | ✔ | ✔ | ✔ | ✔ | ✔ | | ✔ | ✔ |
| psa.write | ✔ | ✔ | ✔ | | | | | |
| psa.credentials.manage | ✔ | | ✔ | | | | | |
| services.read | ✔ | ✔ | ✔ | ✔ | ✔ | | ✔ | ✔ |
| services.write | ✔ | ✔ | | | ✔ | | | |
| deployments.read | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| deployments.write | ✔ | ✔ | ✔ | | | | | |
| deployments.package.generate | ✔ | ✔ | ✔ | ✔ | | | | |
| deployments.commands.issue | ✔ | | ✔ | | | | | |
| database.metadata.read | ✔ | ✔ | ✔ | ✔ | | ✔ | ✔ | |
| health.read | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| integrations.read / .manage | ✔/✔ | ✔/✔ | ✔/✔ | ✔/ | ✔/ | ✔/ | ✔/ | ✔/ |
| licenses.read / .manage | ✔/✔ | ✔/✔ | ✔/ | | ✔/ | | ✔/ | ✔/ |
| audit.read | ✔ | ✔ | | | | ✔ | ✔ | |
| users.read / users.manage | ✔/✔ | ✔/✔ | | | | ✔/ | ✔/ | |
| roles.read / roles.manage | ✔/✔ | ✔/ | | | | ✔/ | ✔/ | |
| settings.read / settings.manage | ✔/✔ | ✔/✔ | ✔/ | | | ✔/ | ✔/ | |
| security.manage | ✔ | | | | | ✔ | | |

- **Client scope:** roles carry `scope = all_clients | assigned_clients`. If any of a user's roles is `all_clients`, the user sees all clients. Otherwise the user sees only rows in `user_client_assignments`. This is enforced in RLS via `app.scope_all` and `app_can_access_client()`.
- **Escalation guards:** only holders of `roles.manage` may grant `super_admin`, and users cannot change their own roles or status.

## Tenant isolation (implemented)

- The API connects as `psacc_app` (member of `psacc_app_rw`, `NOSUPERUSER NOBYPASSRLS`). The tables are owned by `psacc_owner`, which is used only by the migrator.
- Each request runs `BEGIN; SELECT set_config('app.org_id', $1, true), set_config('app.user_id', $2, true), set_config('app.scope_all', $3, true); … COMMIT;`. Settings are transaction-local, so pooled connections can't leak context.
- Pre-authentication lookups (login by email, session resolution) go through two `SECURITY DEFINER` functions with fixed `search_path` that return only the fields auth needs. The app role cannot `SELECT` across organizations.

## Data protection

- `DATA_ENCRYPTION_KEY` (32 bytes, base64) → AES-256-GCM with random 96-bit IV, versioned envelope `v1.<iv>.<tag>.<ciphertext>`. The key version prefix allows rotation. Production expects the key to come from a secret manager (Vault/KMS); the desk-portal `SecretCipher` pattern is aligned.
- The logger masks keys matching `/pass|secret|token|authorization|cookie|key|otp|code/i` recursively, and never logs request bodies on `/auth/*`.
- API responses never include password hashes, MFA seeds, token hashes, or recovery codes. The only exception is a recovery code's one-time display at creation.

## Transport & headers

- **API:** `helmet` defaults + `Cache-Control: no-store` on authenticated responses; `trust proxy` limited to loopback/configured proxies.
- **Web:** per-request nonce CSP (`script-src 'self' 'nonce-…' 'strict-dynamic'`), `frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` (camera/mic/geo off), HSTS in production.
- Production terminates TLS at the reverse proxy. The agent gateway terminates mTLS itself (Module 7).

## Database least privilege

| Role | Login | Privileges |
|---|---|---|
| `postgres` | bootstrap only | superuser — used once by init script, never by the app |
| `psacc_owner` | yes | owns schema/tables; runs migrations |
| `psacc_app_rw` | no (group) | `SELECT/INSERT/UPDATE/DELETE` on tenant tables, `INSERT/SELECT` only on `audit_events`, `SELECT` on catalogs, `EXECUTE` on auth functions |
| `psacc_app` | yes | member of `psacc_app_rw`; `NOBYPASSRLS` |

The dev PostgreSQL publishes only on `127.0.0.1:55432`. Edge appliance PostgreSQL publishes **no** port (Module 6).

## Edge security (Modules 6–7, designed)

- **Containers:** non-root UID, `read_only: true` root FS + tmpfs, `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`, resource limits, health checks, pinned image **digests**, cosign signature verification in the installer (production).
- **Secrets generated on the client host** by the installer (`.env` with `0600`) — the package contains only the enrollment token (short-lived, single-use) and public CA bundle.
- **Enrollment:** `POST /agent/v1/enroll` with token + CSR (agent-generated ECDSA P-256 key, never leaves host) + locally generated installation ID. Token is consumed atomically (`SELECT … FOR UPDATE` → `consumed_at`). Repeat or duplicate enrollment is rejected and audited; re-enrollment requires a newly issued token.
- **Certificates:** 30-day client certs with SAN `URI:urn:psacc:org:<org>:deployment:<dep>:installation:<inst>`. Renewal starts at 2/3 of the lifetime. Revocation checks `agent_certificates.status` on every request.
