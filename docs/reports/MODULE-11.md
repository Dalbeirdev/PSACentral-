# Module 11 Completion Report — PSA API Configuration & Connection Testing

**Date:** 2026-10-15 · **Environment:** Windows 11, Docker Engine 29.1.3 (WSL), Go 1.25, Node 24.14, PostgreSQL 17, Microsoft Edge (E2E)

## Implementation status: **Complete**

**Test evidence: 483 / 483 passed** on the final code — edge Go 32 (8 new adapter/classification tests; gofmt and vet clean), contracts 42 (3 new), API 266 in 21 files (new `psa-connection.test.ts` with 3 scenarios; both real-Docker suites, now including the fake-PSA connection scenario on two real appliances), web unit 32, Playwright E2E 111 (new `integrations.spec.ts` with a simulated agent over real mTLS; `/integrations` added to the accessibility and responsive sweeps). `pnpm typecheck` clean for all three packages.

**What works now:**
- **Real connection tests run on the appliance**, never on the Control Plane. The local administrator enters the PSA credentials on the appliance's own page (encrypted with the host's data key, never transmitted), optionally a private CA certificate for on-premise servers, and presses *Test connection now*. The appliance authenticates against the PSA API and reads one record; the outcome (a stable code, HTTP status, latency, a redacted detail, a non-secret remote identity) is shown inline and kept in the appliance's `psa_connection_tests` history. The worker repeats the test every 15 minutes once credentials are present, so expired or revoked credentials surface by themselves.
- **Adapters** (`apps/edge/internal/psa`): Autotask and ConnectWise ported from the reference connectors in `desk-portal` (same headers, same probe calls); HaloPSA, Kaseya BMS, Freshservice, ServiceNow (Basic and OAuth password grant) and the custom REST adapter (API key header, Basic, OAuth client credentials) written from vendor documentation. One HTTP client for all: TLS 1.2+, 20 s timeout, at most two redirects, optional private CA.
- **The Control Plane only learns the outcome.** The agent's `psa_integration_status` report now carries the test metadata; on ingestion it is projected onto the PSA instance: *Verified* (with the time of the real success — the database constraint still refuses "succeeded" without it), *Test failed* (credentials marked *Invalid* on 401/403), or back to *Untested* when credentials change. Each status change is audited as `psa_instance.connection.reported` by the appliance.
- **UI**: the new **Integrations** page is the fleet view of PSA connections (counters, server-side filters, per-row last test with code / HTTP / latency / who ran it, link to the appliance); the PSA instance page shows what the bound appliance reported and a **Connection tests** history table; deployment health carries a `psa_failed` finding with the code and HTTP status while a test fails.
- **Verified end to end on real appliances** (Docker suite): a fake PSA over TLS with a private CA on the host; the appliance's test fails with `tls_error` until the CA is entered, then succeeds; the Control Plane shows *Verified* with the real success time; a wrong API key yields `auth_failed` / HTTP 401 on the appliance, *Test failed* / *Invalid* credentials on the Control Plane and a `psa_failed` health finding; an appliance without credentials refuses the test before any request leaves it. No credential value appears in any stored test, log, report or API response.

**Honest limits:**

| Area | Status |
|---|---|
| Vendor verification | Autotask and ConnectWise probes are the ones the production `desk-portal` connectors use. HaloPSA, Kaseya BMS, Freshservice, ServiceNow and custom REST are implemented from vendor documentation and verified against fake servers only; no live tenant of those vendors was available. |
| Autotask zone URLs | Must be on `autotask.net` (Control Plane validation), so the end-to-end Docker scenario uses the custom REST adapter against the fake PSA; the Autotask header/probe logic is covered by the Go unit tests. |
| What the test proves | Authentication and one read. Write permissions, webhooks and field mappings are Module 12. |
| Central history granularity | The Control Plane's *Connection tests* list is derived from the agent's reports (one per report interval), so two tests run within seconds of each other on the appliance appear centrally as the latest one only; the appliance's own page keeps every test. |
| Credential rotation | Manual on the appliance; there is no central rotation (by design: the Control Plane holds no credentials). |

---

## Deliverables

| Part | Implementation |
|---|---|
| Edge adapters | `apps/edge/internal/psa/psa.go` (client, classification, `Run`), `adapters.go` (7 providers), `tester.go` (loads and decrypts credentials for the call, records `psa_connection_tests`, `psa_connections`, `integration_logs`), `psa_test.go` (fake TLS servers per provider, outcome classification, secret-leak checks, timeout, private CA). |
| Edge database | Migration `0003_psa_connection_tests.sql`: test columns on `psa_connections` (`status = 'verified'` requires `last_success_at`), `psa_connection_tests` history, `edge_psa_status()` for the inspector role. Required tables: 14. |
| Local admin UI | `/credentials`: private CA field (PEM, validated), **Test connection now** (`POST /credentials/test`, audited `psa_connection.tested`), inline outcome, last ten tests; dashboard shows the last outcome; `/api/status` exposes `connectionTested` and `lastTest`. Saving credentials resets the status until the next test. |
| Worker | Periodic re-test (`PSA_EDGE_PSA_TEST_INTERVAL`, default 15 m) once credentials are present; honest log line (tests implemented, synchronization not yet). |
| Agent report | `psa_integration_status` adds `apiCallsImplemented: true`, `lastTestCode`, `lastTestHttpStatus`, `lastTestLatencyMs`, `lastTestedBy`, `lastSuccessAt`, `remoteIdentity`, `consecutiveFailures`, 24-hour counters (optional, strict schema; old agents still validate). |
| Contracts | `PSA_TEST_CODES` + labels, extended report schema, `PsaApplianceStatus`, `PsaConnectionTestDto`, `IntegrationRow`, `integrationListQuerySchema`; `PsaInstanceDetail.appliance`. |
| API | `apps/api/src/modules/psa/psa-connection.ts` (`applyPsaReport`, `applianceStatuses`, `connectionTests`), called from report ingestion; routes `GET /psa-instances/:id/connection-tests` (`psa.read`) and `GET /integrations` (`integrations.read`); health rule message with code and HTTP status. |
| Web | `/integrations` (placeholder replaced), PSA instance page connection card + history table, navigation marks Module 11 delivered. |
| Docs | `ARCHITECTURE.md` §4.11, `UI_DESIGN.md` §12, `RUNBOOKS.md` §6 (credentials, private CA, codes), `MODULE_PLAN.md`, README. |

## Security

- **Credentials never leave the appliance**: entered on the loopback-only local admin page, encrypted at rest (AES-256-GCM with the host's data key), decrypted only for the duration of a test. The Control Plane, the agent gateway, the reports and the audit trail carry codes and statuses only; the Docker suite checks the stored tests, logs, reports and API responses for the secret value (0 hits) and the evidence files were scanned (0 hits).
- **Outbound only, bounded**: the test is one read-only request (two for OAuth providers) with TLS 1.2+, a 20 s timeout, two redirects at most, and system roots plus an explicit private CA; no `InsecureSkipVerify`.
- **No fake verification**: the appliance's `psa_connections` and the Control Plane's `psa_instances` both refuse "verified / succeeded" without a recorded success time (database constraints); reports naming a different instance code are ignored; the viewer role sees the fleet view read-only, and there is no Control-Plane control that would call a PSA.
- **Audited** on both sides: `psa_connection.tested` (appliance, with code / HTTP / latency) and `psa_instance.connection.reported` (Control Plane, by the appliance actor, with from/to statuses). Audit metadata keys avoid the word "credential" so the secret masker does not hide the statuses.
- **Tenant isolation** verified through the API and SQL: another organization cannot read an instance's tests or see it on the Integrations page.

## Testing — executed results

Raw output in [`module-11/`](module-11): `edge-go-test.txt`, `typecheck.txt`, `contracts-vitest.txt`, `api-vitest.txt` (both real-Docker suites, including the fake-PSA connection scenario), `web-vitest.txt`, `e2e-playwright.txt`; screenshots in [`module-11/screenshots/`](module-11/screenshots) (appliance local admin page with a real test outcome, Integrations page, PSA instance page with history).

| Suite | Command | Result | Evidence |
|---|---|---|---|
| Edge agent (Go 1.25, in Docker) | `gofmt -l . ; go vet ./... && go test -cover ./...` | **32 passed**, format and vet clean — `internal/psa`: Autotask headers and probe, ConnectWise Basic + clientId, OAuth providers (Halo, Kaseya, ServiceNow, custom), Basic/API-key providers, outcome classification (401/403/404/429/5xx/3xx/non-JSON), missing credentials never reach the network, TLS error without the private CA, invalid PEM, unreachable host, timeout | `edge-go-test.txt` |
| Typecheck | `pnpm typecheck` | **clean** (contracts, api, web) | `typecheck.txt` |
| Contracts (Vitest) | `packages/contracts` | **42 passed** (7 files) — extended report schema, codes and labels, integration list query | `contracts-vitest.txt` |
| API (Vitest unit + integration) | `apps/api` | **266 passed** (21 files) — projection to the instance (verified / failed / untested, credential status, real success time, audit), history endpoint, fleet view and ordering, foreign instance codes ignored, RBAC and isolation, database constraint; `edge-docker.test.ts`: two real appliances, fake PSA over TLS with a private CA, `tls_error` → verified → `auth_failed` / HTTP 401 → restored, no credentials → `not_configured`, Control Plane status and health finding, no secret in any store or response | `api-vitest.txt` |
| Web unit (Vitest) | `apps/web` | **32 passed** (5 files) | `web-vitest.txt` |
| Browser E2E (Playwright, Edge, production build) | `apps/web` | **111 passed** in 3.8 min — Integrations page counters, filters, row details and links after simulated reports; PSA instance connection card and history; read-only users; axe on the page; responsive at 375 px; all earlier modules | `e2e-playwright.txt` |

Docker was available: nothing is marked BLOCKED. After the final run no `psacc-dep-*` or `psacc-cp*` containers or volumes remain on the shared engine; the other stacks on it were never touched. The edge image was rebuilt (`psacc/psa-edge:0.1.0`) with the adapters and migration 0003.

Coverage by the spec's checklist: unit (Go adapters per provider with fake TLS servers, classification of 401/403/404/429/5xx/3xx/non-JSON, timeout, unreachable host, TLS error with and without the private CA, missing credentials never reach the network; contracts schema; health rule), API (projection, history, fleet view, RBAC, isolation, ignored foreign instance codes, database constraint), database (appliance migration 0003, constraints, inspector function), integration (real appliance → fake PSA over TLS → Control Plane status, audit, health finding), UI/E2E (Integrations page counters/filters/rows, PSA instance history, read-only users; a11y on `/integrations` and the instance page; responsive at 375 px), validation, auth/RBAC, tenant isolation, error handling, negative paths, security scan.

## Issues found and resolved

| # | Issue | Cause | Resolution |
|---|---|---|---|
| 1 | Audit metadata showed `[REDACTED]` for the credential *status* | The audit reader masks any metadata key containing "credential" (correct for secrets) | The projection records statuses under `authStatus`; the masker is unchanged |
| 2 | A second `Run()` with a different CA on the same `Conn` reused the first HTTP client | The client is built once per `Conn` | Documented; the tester builds a fresh `Conn` per test (unit test adjusted) |
| 3 | The Docker scenario could not point an Autotask instance at the fake PSA | Control Plane validation requires Autotask zone URLs on `autotask.net` (kept) | The scenario uses a custom REST instance for the same client; Autotask/ConnectWise probes are covered by the Go unit tests |
| 4 | `gofmt` had drifted on four pre-existing files | Earlier evidence used `gofmt -l` without failing on output | Files formatted; the evidence command now prints any unformatted file before vet |
| 6 | The Docker suite expected the appliance's `tls_error` test to appear in the central history | Two tests ran within one report interval; the report carries the latest test only | The suite checks the appliance's own history for it; documented as a limit above |
| 7 | After a private CA is stored, the Docker suite counted it as a credential | The CA is kept in `credential_store` (encrypted) under its own key | Counts exclude the CA key on the appliance (worker, local admin UI, test) |
| 8 | The full-suite run broke two order-dependent assumptions: the new suite expected no appliance report on a seeded instance, and the Module 3 PSA list test asserted that no instance could ever be "succeeded" | Other suites now enroll real appliances against the same seeded instances; Module 11 makes "succeeded" reachable | The new suite no longer assumes a pristine instance; the older test now asserts the invariant that matters (every succeeded instance carries a real success time and is not synthetic) |
| 9 | `pnpm typecheck` failed on the new health-rules unit test | A spread object widened literal types | Built through the typed `report()` helper; typecheck rerun clean |
| 10 | One E2E test (deployments, unrelated to this module) failed once with a browser console error `net::ERR_NO_BUFFER_SPACE` | Windows socket buffer exhaustion while the Docker suites ran on the same machine | Environmental; the E2E suite was rerun on its own and passed |
| 5 | Schema and table-count expectations (13 tables, migration 0002) across the Docker, milestone and explorer suites | New appliance migration | Updated to 14 tables / 0003 everywhere |

## Outstanding

- Module 12: ticket synchronization on the appliance (the system of record), using these adapters; write-permission checks and field mappings.
- Verify the HaloPSA, Kaseya BMS, Freshservice and ServiceNow probes against live tenants when credentials for test tenants are available.

## Next module

**Module 12 — Advanced PSA synchronization** (ticket management and the sync engine on the appliance; counts and statuses reported centrally). Alternatively Module 13 or 14 per the plan.
