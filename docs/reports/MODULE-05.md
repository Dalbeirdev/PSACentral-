# Module 5 Completion Report — Deployment Records & Package Generation

**Date:** 2026-10-14 · **Environment:** Windows 11, Docker Engine 29.1.3 + Compose 2.40.3 (WSL), Node 24.14, PostgreSQL 17, Microsoft Edge (E2E)

**Order:** approved before Module 4 to reach the first milestone sooner (two Docker client installations on one dashboard). See `docs/MODULE_PLAN.md`.

## Implementation status: **Complete** (Module 5 scope)

**343 / 343** automated tests passed, with none skipped or blocked:

| Suite | Tests |
|---|---|
| API unit | 72 |
| API integration (real PostgreSQL) | 140, including 5 on the **real Docker Engine** |
| Contracts | 30 |
| Web unit | 24 |
| End-to-end in Edge, desktop and 375px mobile | 77 |

All Module 1–3 tests still pass.

**What works now:**
- Deployments can be created for any client, and the spec's 12-step backend generates a package for each.
- Packages are downloaded with SHA-256 verification, and each download is recorded.
- Packages can be regenerated (with confirmation) or revoked (with a reason), and expire when their token does.
- Onboarding steps 8–10 use the real package.

**Honest limits:**
- The package references the standard PSA Edge image, which is **built in Module 6**. Its `compose.yaml` is validated by real Docker, and each package's own PostgreSQL service was started and checked. The edge application containers cannot start until that image exists.
- Enrollment (the token being consumed and the agent getting its certificate) is Module 7. Health reports are Module 8.
- A download never moves a deployment past *Package downloaded*.

---

## Frontend

| Route | What it does |
|---|---|
| `/deployments` | Directory with lifecycle stage tiles. The counts come from `/deployments/stats` and clicking a tile filters. Also: server-side search (code, client, host, PSA), filters (lifecycle, health, environment), sorting, pagination, package status, synthetic badges, and *Synthetic — not live* in place of heartbeats. |
| `/deployments/new` | **Full-page form** (no pop-ups). Inline client search, with `?clientId=` preselecting from the client's Deployments tab. The client's active PSA instances are radio cards. Environment cards fix the OS for Windows and Linux Docker hosts. Then OS, architecture and host label, with inline validation. |
| `/deployments/[id]` | Overview, with these cards: <ul><li>**Lifecycle tracker**: generated → downloaded → installed & enrolled → verified. Each stage shows its evidence time, or exactly what it is waiting for: “A download is not an installation”.</li><li>**Identity**: Deployment, Client, PSA instance and Installation IDs; enrollment token prefix and expiry; “Agent certificate: issued at enrollment”.</li><li>**Platform and image**: version, and the digest as “not published yet”.</li><li>**PSA integration**: endpoint, connection, credentials, and the services on this appliance.</li><li>**Agent and database**: not enrolled, never heartbeated, no reports.</li><li>Recent activity.</li></ul> |
| `/deployments/[id]/installation` | <ul><li>**Readiness checklist** from the server.</li><li>**Package panel**: generate with a token validity of 1, 4, 24 or 72 h. Download (fetch with CSRF; the blob is saved under the server's file name). *Generate a new package* with an inline replace confirmation. *Revoke* with an inline reason form. File list with per-file SHA-256 and the token-bearing file flagged.</li><li>**Install and verify**: commands for Linux and Windows, and the steps that explain what each status means.</li><li>**Package history**.</li></ul> |
| `/deployments/[id]/settings` | Change the PSA instance, target or host label while the deployment is a draft. Otherwise an inline explanation, with a link to revoke first. |
| `/deployments/[id]/health`, `/database`, `/logs` | Honest *Planned · Module 8/9*: “No reports received”, and what will appear there. No sample values and no controls. |
| `/clients/[id]/deployments` | Adds a **New deployment** button. |
| Onboarding steps 7–10 | Step 8 embeds the real package panel, with readiness problems listed and instructions. Step 9 shows *Package downloaded: Done* but *Agent enrolled: waiting*. Step 10 lists generated and downloaded as done, installed as pending, and offers **Open deployment**. |

**Permissions in the UI:**
- Generate, download and revoke need `deployments.package.generate`.
- New deployment and Settings need `deployments.write`.
- Read-only users see package metadata and SHA-256 but no controls; `/deployments/new` and `/settings` return 404 for them.

## Backend (all under `/api/v1`)

| Endpoint | Permission | Notes |
|---|---|---|
| `GET /deployments` | `deployments.read` | `q`, `clientId`, `lifecycle`, `health`, `environment`, a whitelisted `sort`, pagination. Scoped by RLS. |
| `GET /deployments/stats` | `deployments.read` | Count per lifecycle state |
| `POST /deployments` | `deployments.write` | Draft. Requires an accessible client that is not suspended or offboarded, and an active PSA instance **of that client**. The OS must match fixed-OS environments. Audited as `deployment.created`. |
| `GET /deployments/:id` | `deployments.read` | Detail, readiness checks, current package and history (metadata only), the edge image and gateway the next package will use, and `version` |
| `PATCH /deployments/:id` | `deployments.write` | Draft only, with optimistic concurrency. Audited as `deployment.updated` with a field diff. |
| `POST /deployments/:id/packages` | `deployments.package.generate` | Generates the package (table below). An existing usable package → 409 `package-exists` unless `replaceExisting: true`. Not ready → 422 `not-ready`. Rate limited. |
| `POST /deployments/:id/packages/:pid/download` | `deployments.package.generate` | `application/zip`, `Content-Disposition`, `Cache-Control: no-store`, `X-Content-SHA256`. The archive is decrypted and its SHA-256 re-verified before sending. Unusable packages → 410 `package-unavailable`. Recorded and audited, and the first download moves the lifecycle to `package_downloaded`. Rate limited. |
| `POST /deployments/:id/packages/:pid/revoke` | `deployments.package.generate` | Reason of 3–200 characters. Revokes the token, purges the archive, and returns the deployment to `draft`. |
| `GET /deployments/:id/activity` | `deployments.read` | Audit events for the deployment |

**Package generation, as the spec's backend steps:**

| # | Step | Implementation |
|---|---|---|
| 1–3 | Validate client, PSA instance, services | Readiness checks: <ul><li>A real, non-synthetic record.</li><li>Not enrolled.</li><li>Client not suspended or offboarded.</li><li>PSA instance active, and its configuration and endpoint **re-validated by the provider adapter**.</li><li>At least one service assigned, and at least one enabled on the PSA instance.</li><li>Target platform complete.</li></ul> |
| 4 | Deployment record | `DEP-nnnnn` + UUID |
| 5 | Unique identity | New installation ID (UUID) per package; registered at enrollment in Module 7 |
| 6 | Single-use token | `psacc_enr_` + 256 random bits. **Only the SHA-256 and a 4-character prefix are stored.** Expires in at most 72 h. |
| 7–9 | Configuration, Compose, documentation | Templates in `apps/api/templates/edge-package/` → `config/edge.json`, `compose.yaml`, `compose.production.yaml`, install and verify scripts (`.sh` + `.ps1`), `README.md` / `INSTALL.md` / `UNINSTALL.md` |
| 10 | ZIP | `fflate`. Unix modes stored: 0755 for scripts, 0600 for the token file. CRLF + BOM for PowerShell. |
| 11 | Metadata | Manifest (path, size, SHA-256 per file), ZIP SHA-256 and size, image, target, configuration snapshot. The archive is held **encrypted** (AES-256-GCM, bound to the package ID) only while usable. |
| 12 | Audit | `deployment.package.generated`: number, installation ID, SHA-256, size, image, token *prefix* and expiry, superseded package |

**Expiry:**
- A SECURITY DEFINER function, `app_expire_deployment_packages(org?)`, does the work. It runs lazily at the start of each deployment request (scoped to the caller's organization) and every 5 minutes for all organizations.
- It purges expired archives, returns the deployment to `draft`, and writes a `deployment.package.expired` system audit event.
- It restores the caller's tenant context afterwards; a test checks this.

**Package contents:**

| Item | Detail |
|---|---|
| Compose project | `psacc-dep-nnnnn` |
| Services | `edge-postgres` (PostgreSQL 17: data checksums, SCRAM authentication, **no published port**, internal network only), `edge-migrate` (one-shot), `edge-api` (local admin UI on `127.0.0.1:18000+n`), `edge-worker` (PSA adapter and sync, direct PSA egress), `edge-agent` (outbound only, token mounted read-only) |
| Named volumes | `pgdata`, `edge-logs`, `edge-backups`, `agent-state` |
| Hardening (edge services) | Read-only root filesystem, uid 10001, `cap_drop: ALL`, `no-new-privileges`, tmpfs `/tmp`, log rotation |
| Secrets | Compose file secrets generated **on the host** by the install script |
| Production overrides | Refuse to render unless **both** images are pinned by digest; resource limits |
| `install.sh` / `install.ps1` | Prerequisite and token-expiry checks; creates `./secrets` (0700, files 0444) and an owner-only ACL on Windows; `.env`; validates; pulls; starts. `--prepare` / `-Prepare` stops before pull and start. Safe to re-run. |
| `verify.sh` / `verify.ps1` | Twelve PASS/FAIL checks, from Docker through the containers, database, migrations and the 12 edge tables to agent enrollment |

## Database — migration `0004_deployment_packages.sql`

| Table | Contents | Constraints |
|---|---|---|
| `deployment_packages` | Number, status, installation ID, image, target, config snapshot, manifest, SHA-256, size, encrypted archive, download counters, revocation | <ul><li>**One usable package per deployment** (partial unique index).</li><li>An archive only while `active`, and an active package always has one.</li><li>Revoked needs a time and a reason.</li><li>Composite FKs to `deployments(client_id, id)` and `clients`.</li></ul> |
| `enrollment_tokens` | 32-byte hash (unique), display prefix, issued and expiry times, consumed or revoked | <ul><li>Lifetime of at most 72 h (`CHECK`).</li><li>Never both consumed and revoked.</li><li>**One open token per deployment** (partial unique index).</li></ul> |
| `deployment_package_downloads` | User, time, IP, user agent, SHA-256 | Append-only: the app role has SELECT and INSERT only |

- All three use FORCE RLS with client scope.
- Grants: no DELETE on any of them.
- The dev seed reset was updated for the new foreign keys.

## Security

- **No permanent secret in a package.** A unit test and an integration test scan every file for the data key, CSRF secret, seed password, database URL and literal passwords. The only secret is the short-lived, single-use token, and only in `enrollment/enrollment.json`.
- **The token is never stored or shown readable.** It appears in neither API responses nor audit metadata, and the tests check this. The database holds its SHA-256; a test confirms the downloaded token hashes to the stored value.
- **The archive is encrypted at rest** while usable and purged as soon as it is superseded, revoked or expired; a database constraint enforces this.
- **Downloads** are `POST` with CSRF and Origin checks, `no-store`, rate limited, integrity-checked and recorded per download.
- **RBAC:**

  | Actor | Access |
  |---|---|
  | Read-only, auditor | 403 on generate, download, revoke and edit |
  | Technician, service manager, read-only, auditor | 403 on create |
  | Technician | Generate and download **only for assigned clients**; 404 otherwise |

- **Isolation:** organization B gets 404 on organization A's deployment detail, generation, download and revoke. With no tenant context, all three new tables return 0 rows.
- **Configuration:** staging and production require a pinned `EDGE_IMAGE_DIGEST` and a non-localhost https `AGENT_GATEWAY_URL`; unit tests cover both.

---

## Testing — executed results

Raw output: [`module-05/api-vitest.txt`](module-05/api-vitest.txt), [`contracts-vitest.txt`](module-05/contracts-vitest.txt), [`web-vitest.txt`](module-05/web-vitest.txt), [`e2e-playwright.txt`](module-05/e2e-playwright.txt), [`typecheck.txt`](module-05/typecheck.txt) (all packages clean). Screenshots: [`module-05/screenshots/`](module-05/screenshots) (16 images). The evidence files were scanned for secrets and enrollment tokens; none were found.

| Suite | Files | Tests | Result |
|---|---|---|---|
| API unit | 4 | 72 | ✅ |
| API integration (real PostgreSQL, rebuilt per run) | 8 | 135 | ✅ |
| **API integration on the real Docker Engine** | 1 | 5 | ✅ (not blocked) |
| Contracts | 4 | 30 | ✅ |
| Web unit | 3 | 24 | ✅ |
| E2E — Edge, production build, desktop 1440px + mobile 375px | 9 | 77 | ✅ |
| **Total** | **29** | **343** | **✅ 0 failed, 0 skipped** |

### Representative Module 5 cases

| # | Category | Test | Input | Expected | Actual | ✓ |
|---|---|---|---|---|---|---|
| 1 | Unit | Template rendering | `{{x}}`, `{{.ExitCode}}`, an undefined variable | Filled; Go template untouched; throws | As expected | ✅ |
| 2 | Unit | Package structure | Build for DEP-00042 | 14 files under `psacc-dep-00042/`; manifest, `CHECKSUMS.sha256` and per-file SHA-256 all match; no unrendered placeholder | As expected | ✅ |
| 3 | Security | Secrets in the package | All files | Token only in `enrollment/enrollment.json`; no literal password or connection string | As expected | ✅ |
| 4 | Unit | Compose isolation | `compose.yaml` | Project `psacc-dep-00042`; no `ports` on PostgreSQL; internal network; loopback admin port 18042; four named volumes | As expected | ✅ |
| 5 | Unit | File formats | ZIP central directory | `install.sh` 0755 + LF; `.ps1` BOM + CRLF; token file 0600 | As expected | ✅ |
| 6 | Validation | Create | Read-only, technician, auditor, service manager; Windows host + Linux OS; `x86`; `bad;label`; another client's PSA; unknown client | 403 ×4; 400 at `targetOs`, `targetArch`, `hostLabel`, `psaInstanceId`, `clientId` | As expected | ✅ |
| 7 | API | List and stats | `lifecycle=verified`, `q=Bluepeak`, `sort=code:asc`, bad lifecycle and sort, technician caller | Filtered and sorted results; 400 ×2; stats match the list; technician sees only assigned clients | As expected | ✅ |
| 8 | Business rules | Readiness | Synthetic DEP-00001; PSA config broken behind the API (`webservices99`); client suspended; validity 0, 2, 73, 168 h | 422 `not-ready` (record, PSA config, client); 400 ×4 | As expected | ✅ |
| 9 | Integration | Generate | 4 h token | 201, `package_generated`, expiry exactly 4 h after issue, prefix only, token absent from the response; archive stored as `v1.` ciphertext; audit records SHA-256 and validity | As expected | ✅ |
| 10 | Security | Token at rest | Download, read `enrollment.json` | SHA-256(token) equals the stored hash; token absent from the archive ciphertext, config snapshot, manifest and every audit row | As expected | ✅ |
| 11 | Integration | Download | POST download twice | `application/zip`, attachment file name, `no-store`, SHA-256 header equals stored; two download rows; `downloadNumber` 1 then 2; lifecycle `package_downloaded`, `enrolledAt` null | As expected | ✅ |
| 12 | Business rules | Regenerate | Without confirmation, then with `replaceExisting` | 409; then #2 with a new installation ID; #1 superseded with its token revoked and archive purged; old download 410 | As expected | ✅ |
| 13 | Business rules | Revoke | Reason "no", then a valid reason, then again | 400; 200 with draft and the reason stored; 409 the second time; download 410 | As expected | ✅ |
| 14 | Business rules | Expiry | Token moved 1 h into the past | Package `expired`, archive gone, deployment `draft`, system audit `deployment.package.expired`, download 410; a new package is allowed, with exactly one open token | As expected | ✅ |
| 15 | Database | Sweep function | Cross-organization run; run inside a tenant transaction | At least one expired; the caller's `app.org_id` is unchanged afterwards | As expected | ✅ |
| 16 | Database | Constraints | 73 h token; revoked while still holding the archive; UPDATE on a download row; DELETE a package | `enrollment_tokens_lifetime`; `archive_only_when_active`; permission denied ×2 | As expected | ✅ |
| 17 | RBAC | Read-only and auditor | Generate, download, revoke | 403 ×3 each; metadata (SHA-256) still visible | As expected | ✅ |
| 18 | RBAC | Technician | Assigned client; unassigned client | 201 + download 200; 404 on detail and generate | As expected | ✅ |
| 19 | Tenant isolation | Org B | Detail, generate, download, revoke on an org A deployment; app role with no context | 404 ×4; 0 rows in all three tables | As expected | ✅ |
| 20 | **Docker** | Package validity | Autotask and ConnectWise packages generated through the API, extracted on Linux | `sha256sum -c` OK; `bash -n` OK; modes 755/755/600; `docker compose config` OK | As expected | ✅ |
| 21 | **Docker** | Production pinning | Leave `PSA_EDGE_IMAGE` unset, then `PSA_POSTGRES_IMAGE`; then pin both | Each refused with its own message; accepted when pinned; rendered services read-only, `cap_drop ALL`, uid 10001 | As expected | ✅ |
| 22 | **Docker** | `install.sh --prepare` | Run twice per package | `secrets/` 0700, files 0444 and 44 bytes; second run keeps the secrets (same hashes); `.env` created; secrets differ between the two clients | As expected | ✅ |
| 23 | **Docker** | Separate databases | `up --wait edge-postgres` for both packages | Own `psacc-dep-*_pgdata` volume; internal network; **no port bindings**; owner login works with that host's secret; **client B's password is rejected by A's database**; A **cannot reach** B's database | As expected | ✅ |
| 24 | **Docker** | Persistence | Write a row; restart; down/up | Row survives both; B's database has no tables | As expected | ✅ |
| 25 | E2E | Create from the client tab | Harbor → New deployment; no environment; Windows host; bad label | Inline errors; OS fixed and disabled for Windows; created → "Deployment DEP-nnnnn created." with a pending lifecycle | As expected | ✅ |
| 26 | E2E | Installation | 4 h → generate → **download** → settings → replace → revoke → settings | SHA-256 of the downloaded file equals the page; ZIP contains the 9 key files; *Package downloaded* shown; settings locked; inline replace with #1 *Replaced / Token revoked*; reason required; #2 revoked; arm64 saved and audited | As expected | ✅ |
| 27 | E2E | Wizard | Steps 7–10 with a real generate and download | Package #1; SHA-256 matches; step 9 *Downloaded: Done, enrolled: waiting*; step 10 → Open deployment → tracker *downloaded: done, installed: not yet* | As expected | ✅ |
| 28 | E2E | Read-only and synthetic | Viewer on installation; DEP-00002 | No download, revoke or generate controls; no Settings tab; 404 on new and settings. Synthetic: alert, readiness explains, generate disabled; health shows *No reports received* | As expected | ✅ |
| 29 | Accessibility | axe WCAG 2.1 AA | `/deployments`, `/deployments/new`, and overview, installation, health, database, logs and settings | 0 serious or critical | 0 | ✅ |
| 30 | Responsive | 375px | List, new, overview, installation | No horizontal page scroll | As expected | ✅ |
| 31 | Negative (global) | Every E2E test | — | No dialogs, uncaught errors or console errors | None | ✅ |

## Issues found and resolved

| # | Issue | Cause | Resolution |
|---|---|---|---|
| 1 | The agent container could not have read `enrollment.json` (0600, host user) | Bind-mounted files keep host ownership, but the container runs as uid 10001 | The install script makes the directory 0700 and the file 0444, like `./secrets`; an owner-only ACL on Windows |
| 2 | `RandomNumberGenerator::Fill` is missing in Windows PowerShell 5.1 | .NET Framework | `Create().GetBytes()` |
| 3 | `verify.ps1`: `-T` and `-U` would bind as PowerShell parameters | An advanced function with a param block | A simple function using `$args` |
| 4 | The `{{.ExitCode}}` Go template could be read as a placeholder | Template syntax overlap | Placeholders must start with a letter; a unit test covers it |
| 5 | The SECURITY DEFINER sweep would clear the caller's tenant context | `set_config` is transaction-local | The previous values are saved and restored; a test covers it |
| 6 | Token lifetime CHECK could fail by microseconds | Two `clock_timestamp()` calls | Issue and expiry times are derived from one DB `now()` |
| 7 | Readiness URL overflowed its card at 375px | Long unbroken URL | `overflow-wrap:anywhere` |
| 8 | Dev seed reset would fail with packages present | New foreign keys | The reset deletes the new tables first |
| 9 | 6 test-side issues | `asApp` rolls back; owner reads under FORCE RLS; a `$1` swallowed by a PowerShell here-string; shared CL-00001 counts; Compose interpolation order; an E2E click before navigation finished | Fixed in the tests; no product change |

## Outstanding (preserved backlog)

- **Module 6:** the PSA Edge image (edge-migrate, api, worker and agent) and the 12 edge tables. The package's verify script already checks them. Signed image digests follow, after which `EDGE_IMAGE_DIGEST` is set.
- **Module 7:** the agent gateway (mTLS), enrollment consuming the token (`consumed` status), installation identity registration, machine certificate, and handling of invalid, duplicate or revoked identities.
- **Module 8 / 9:** health reports and the table inventory on the deployment's Health, Database and Logs pages.
- **Module 4:** catalog administration (deferred, by approval).
- Cross-cutting items are unchanged: SEC-OIDC, SEC-KMS, OBS-OTEL, OPS-REGISTRY, OPS-IMGEXPORT (`docker save` / OCI export is separate from ZIP packages), DOC-BACKUP and TEST-LOAD.

## Next module

**Module 6 — Edge appliance & PostgreSQL initialization:**
- The Go module with `edge-migrate`, `edge-api` (including the local admin/setup UI), `edge-worker` and `edge-agent`, built into the standard non-root image.
- Edge migrations for the 12 tables.
- Idempotent initialization with separate owner, application and catalog-only inspector roles.
- The encrypted credential store.
- Real Docker tests that install two generated packages end to end.
