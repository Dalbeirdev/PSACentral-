# Module 7 Completion Report — Secure Enrollment & Communication

**Date:** 2026-10-14 · **Environment:** Windows 11, Docker Engine 29.1.3 + Compose 2.40.3 (WSL, mirrored networking), Go 1.25, Node 24.14, PostgreSQL 17, Microsoft Edge (E2E)

## Implementation status: **Complete** (Module 7 scope)

**388 / 388** automated tests passed, with none skipped or blocked:

| Suite | Tests |
|---|---|
| Go unit (edge appliance) | 20 |
| API unit | 72 |
| API integration, including **16 on the real Docker Engine** | 161 |
| Contracts | 30 |
| Web unit | 24 |
| End-to-end in Edge, desktop and 375px mobile | 81 |

All Module 1–6 tests still pass. The first full run had three failures (a stale expected-table list, a stale wizard message, and a hydration error on the enrolled deployment page); all three are fixed and listed under Issues, and the complete rerun passed.

**What works now:**
- The spec §14 enrollment flow runs end to end on the real Docker Engine for two client appliances, Autotask (A) and ConnectWise (B):

  | Step | What happens |
  |---|---|
  | 1. Administrator creates the deployment | Real (Modules 5–6) |
  | 2. Short-lived token | Real (Modules 5–6) |
  | 3. Client installs the appliance | Real (Modules 5–6) |
  | 4. Agent contacts the Control Plane | Outbound only, TLS pinned to the platform CA from the package |
  | 5. Control Plane validates the token | |
  | 6. Installation identity registered | |
  | 7. Agent obtains its machine certificate | |
  | 8. Token permanently invalidated | |
  | 9. Agent communicates by machine identity | mutual TLS |

- `verify.sh` now passes **13 of 13** checks on both appliances.
- Shown on the real engine:
  - The dashboard records enrollment and live heartbeats.
  - The certificate renews.
  - A Control Plane outage is tolerated.
  - Revocation is immediate.
  - A replayed token is refused.
  - Duplicate, expired, revoked and mismatched identities are refused.

**Honest limits:**
- Heartbeats prove liveness and the agent version only. Health reports, the health rules engine and *Verified* are Module 8; the table inventory is Module 9. Until then a deployment's health stays *Unknown* and its lifecycle stops at *Enrolled*.
- The CA and gateway keys are encrypted with the application data key. A KMS or HSM is backlog item SEC-KMS.
- There is no CRL or OCSP: the gateway checks every certificate against the database on each request, so revocation is immediate inside the platform.

---

## Control Plane

| Part | Implementation |
|---|---|
| Internal CA (`PkiService`) | ECDSA P-256 CA, valid 10 years, created on first use. It issues the gateway's TLS server certificate (P-256, 397 days), with SANs from `AGENT_GATEWAY_URL` plus `localhost` and `127.0.0.1` and any extra names. The server certificate is **reissued automatically** when the names change. Private keys are stored as AES-256-GCM envelopes in `pki_authorities`. |
| Packages | `enrollment/enrollment.json` now carries the **CA certificate and its SHA-256 fingerprint**, which the agent pins |
| Agent gateway (`AgentGateway`) | A separate HTTPS listener (`AGENT_GATEWAY_HOST/PORT`), TLS 1.2+. `requestCert` is set, but authorization is per route: <ul><li>`POST /agent/v1/enroll`: token + CSR, no certificate.</li><li>`POST /agent/v1/heartbeat` and `POST /agent/v1/renew`: mTLS **and** a database check of the certificate.</li><li>`GET /agent/v1/health`.</li></ul> Strict request schemas (unknown fields → 400), a 32 KB body limit, and a per-IP rate limit (enrollment 20/min, configurable). The listener starts in the background and retries, so the API never fails to boot because of it. |
| Certificate issuance | The CSR must prove possession, use ECDSA P-256, and carry **CN = installation ID**. Certificates last 90 days, are `clientAuth` only, and carry SANs `urn:psacc:deployment:<id>` and `urn:psacc:installation:<id>` and a random 128-bit serial. |
| Revocation | `POST /deployments/:id/agent-certificate/revoke` (`deployments.write`, reason required). The gateway refuses the certificate immediately. The deployment returns to **draft**, and re-enrolling needs a new package, which brings a new installation ID and token. |
| UI | Deployment overview: <ul><li>A **Machine identity** card: active certificate (serial, fingerprint, validity, last seen, subject), history, and **inline revocation** with a reason.</li><li>Agent status reads "Enrolled (mutual TLS)" or "Certificate revoked — re-enroll with a new package".</li><li>The lifecycle tracker reflects the current state, so a revoked identity is no longer shown as enrolled.</li></ul> |

## Database — migration `0005_agent_enrollment.sql`

- `pki_authorities`: a single row with the CA and gateway certificates and encrypted keys.
- `agent_certificates`: serial, SHA-256 fingerprint (unique), subject, validity, status (`active` / `superseded` / `revoked`), issued via (`enrollment` / `renewal`), last seen, revocation.
  - **One active certificate per deployment** (partial unique index), FORCE RLS with client scope.
- **SECURITY DEFINER gateway functions**, the only way the session-less gateway reaches tenant data: `agent_enrollment_check`, `agent_enrollment_complete`, `agent_identify`, `agent_heartbeat` and `agent_renew`.
  - Each finds the owning organization, sets its context (FORCE RLS stays in effect), re-checks under row locks, acts, audits and resets the context.
- **Two-step enrollment:**
  1. Check the token, without changing anything.
  2. Sign the CSR.
  3. Complete under a lock. Exactly one concurrent request can consume a token, and only its certificate is ever returned.
- Rejections of a known token are audited in that organization (`agent.enrollment.rejected`), as are `agent.enrolled`, `agent.certificate.renewed` and `agent.certificate.revoked`.

## Edge appliance (`psa-edge` 0.1.0, rebuilt)

| Behaviour | Implementation |
|---|---|
| Enrollment | ECDSA P-256 key (0600 in the `agent-state` volume), CSR with CN = installation ID, `POST /enroll` over TLS that trusts **only** the pinned CA. It checks the CA fingerprint and that the returned CA equals the pinned one, then stores the certificate. |
| Heartbeats | Over mTLS every `heartbeatIntervalSeconds` (60 s by default, 15 s in tests) |
| Renewal | Automatic after ⅔ of the certificate's lifetime; `edge-agent renew` forces it |
| Refusals | **Terminal** enrollment errors (token used, expired, revoked, mismatched, duplicate) stop retrying: state `failed`, with the reason shown. **Network errors** back off from 5 s up to 5 min. Certificate refusals (revoked, superseded, expired) end the identity: state `revoked`, and heartbeats stop. |
| Status | `edge-agent status [--require-enrolled]` reports state, serial, certificate expiry, last heartbeat and last error. A secret-free copy is written to the log volume, and the **local admin UI** shows enrollment, last heartbeat and certificate validity. |

---

## Testing — executed results

Raw output is in [`module-07/`](module-07):
- Test runs: `edge-go-test.txt`, `api-vitest.txt`, `contracts-vitest.txt`, `web-vitest.txt`, `e2e-playwright.txt`, `typecheck.txt`.
- **Real appliance enrolled with the dev Control Plane:** `verify-output.txt` (13/13), `agent-status.txt`, `agent-renew.txt`, `agent-log-excerpt.txt`.

Screenshots are in [`module-07/screenshots/`](module-07/screenshots). The evidence files were scanned for secrets, private keys and enrollment tokens; none were found.

| Suite | Files | Tests | Result |
|---|---|---|---|
| Go unit (`go vet` + `go test`) | 6 packages | 20 | ✅ |
| API unit | 4 | 72 | ✅ |
| API integration (real PostgreSQL, rebuilt per run), including the gateway suite (10) | 9 | 145 | ✅ |
| **API integration on the real Docker Engine:** `package-docker` (5) and `edge-docker` (11) | 2 | 16 | ✅ (not blocked) |
| Contracts | 4 | 30 | ✅ |
| Web unit | 3 | 24 | ✅ |
| E2E — Edge, production build with its own agent gateway, desktop 1440px + mobile 375px | 10 | 81 | ✅ |
| **Total** | | **388** | **✅ 0 failed, 0 skipped** |

### Representative Module 7 cases

| # | Category | Test | Input | Expected | Actual | ✓ |
|---|---|---|---|---|---|---|
| 1 | Integration | CA pinning | Package CA vs `pki_authorities`; gateway `/health` with the pinned CA; with a bogus CA | Identical; TLS succeeds; TLS fails | As expected | ✅ |
| 2 | Negative | Bad enrollments | Unknown token; missing fields; another installation ID; CSR for another CN; garbage CSR | 401 `invalid-token`; 400; 403 `identity-mismatch` (audited, `denied`); 400 `csr-subject`; 400 `invalid-csr`; **token still usable afterwards** | As expected | ✅ |
| 3 | Integration | Enrollment | Valid token + CSR | 201. Certificate chains to the CA; CN = installation; EKU `clientAuth` only; deployment and installation SANs; ~90 days. Deployment `enrolled` with installation ID and agent version; package `consumed`; token consumed; `agent.enrolled` audited. | As expected | ✅ |
| 4 | Security | Single use | Same token again | 409 `token-used` | As expected | ✅ |
| 5 | Concurrency | Race | Three simultaneous enrollments with one token | Exactly one 201 and two 409; one certificate in the database | As expected | ✅ |
| 6 | Negative | Expired or revoked token | Token moved 1 h into the past; package revoked | 401 `token-expired`; 401 `token-revoked` | As expected | ✅ |
| 7 | Security | mTLS | Heartbeat without a certificate; with a **self-signed** certificate; with the issued one; with an extra field | 401 ×2; 200 (last-seen moves, version updates, health stays unknown); 400 | As expected | ✅ |
| 8 | Integration | Renewal | Renew with a new CSR; old certificate; new certificate; CSR for another installation | New certificate; old → 403 `superseded`; new → 200; 400 `csr-subject` | As expected | ✅ |
| 9 | Security | Revocation | Read-only revoke; operator revoke; heartbeat with the revoked certificate; revoke again; new package | 403; draft with no installation ID; 403 `revoked`; 409; new installation ID | As expected | ✅ |
| 10 | Isolation | Org B | Detail and revoke on an org A deployment; app role with no context | 404 ×2; 0 rows | As expected | ✅ |
| 11 | Security | Rate limit | 70 enrollment attempts from one address | 429 returned | As expected | ✅ |
| 12 | Go unit | Agent identity | Fake mTLS gateway with its own CA | Enroll (key 0600, state `enrolled`); heartbeat over mTLS; renew (new serial); `revoked` → state `revoked`, heartbeats stop; `token-used` → `failed`; gateway down → `pending`, 5 s backoff; **a gateway with an unpinned CA is never contacted**; renewal due after ⅔ of the lifetime | As expected | ✅ |
| 13 | **Docker** | Two real agents enroll | Install A and B; wait | Both `enrolled`; certificate active; package consumed; installation IDs differ; agent status `enrolled` with the same serial as the Control Plane | As expected | ✅ |
| 14 | **Docker** | `verify.sh` | Both appliances | **13 passed, 0 failed**, exit 0 | As expected | ✅ |
| 15 | **Docker** | Heartbeats | Wait one interval | Last-seen time advances for both | As expected | ✅ |
| 16 | **Docker** | Renewal | `edge-agent renew` in A | Control Plane shows `renewal:active`, `enrollment:superseded`; serials match; heartbeats continue with the new certificate | As expected | ✅ |
| 17 | **Docker** | Control Plane outage | Stop the gateway, then restart it | Agent records the error but keeps its identity; local `/healthz` stays 200; heartbeats resume and the error clears | As expected | ✅ |
| 18 | **Docker** | Persistence | `down` then `up` of A | Identity kept (same serial, no re-enrollment); admin and credentials kept | As expected | ✅ |
| 19 | **Docker** | Revocation | Revoke B in the Control Plane | Agent `revoked` within one interval; verify shows the enrollment FAIL; local appliance still healthy | As expected | ✅ |
| 20 | **Docker** | Replay | Wipe B's agent state and restart it | Re-enrollment with the package's used token refused: state `failed`, `token-used`; `agent.enrollment.rejected` audited | As expected | ✅ |
| 21 | E2E | Machine identity UI | Enroll via the E2E gateway; open the deployment; revoke with no reason, then with one | *Installed & enrolled: done*, "Enrolled (mutual TLS)", serial shown; reason required; then *Certificate revoked*, lifecycle Draft, history row with the reason, both audit events listed | As expected | ✅ |
| 22 | E2E | Read-only and accessibility | Viewer on an enrolled deployment | Identity visible, no revoke control; axe 0 serious | As expected | ✅ |

## Issues found and resolved

| # | Issue | Cause | Resolution |
|---|---|---|---|
| 1 | Containers could not reach a gateway on the Windows host via `host.docker.internal` | Docker Engine runs inside WSL, so `host-gateway` points at the WSL VM | Probed: under mirrored networking, containers reach the host by its address when the gateway listens on `0.0.0.0`. Documented in ARCHITECTURE §4.6, and the Docker test uses it. |
| 2 | The API failed to boot in the E2E stack (`pki_authorities` missing) | Playwright starts the web servers before global setup migrates the E2E database | The gateway starts in the background and retries every 5 s; the API boot no longer depends on it |
| 3 | Agents could not enroll while `install.sh` ran in the Docker test | Synchronous shell calls froze the event loop of the process hosting the gateway | All shell calls in the test are asynchronous |
| 4 | An enrollment test failed only in the full file | The per-IP enrollment rate limit (20/min) was used up by earlier tests | The limit is configurable; the test file uses 60/min and every success is asserted |
| 5 | After a revocation, the tracker still showed *Installed & enrolled* | It was keyed on the historical `enrolled_at` | It is keyed on the current lifecycle state |
| 6 | The API typecheck rejected `CryptoKeyPair` and `EcKeyAlgorithm` | No DOM lib in the API | Node `webcrypto` types |
| 7 | React #418 hydration error on the enrolled deployment page | The identity card rendered relative times, which drift between the server render and the browser | Exact timestamps only in that component |
| 8 | 2 test-side issues | The new `pki_authorities` table in the expected-table list; a stale wizard step-9 message | Fixed in the tests |

## Outstanding

- **Module 8:** health reports over the mTLS channel (the allow-listed report types, delivery of the buffered outbox), the health rules engine, *Verified*, and the health pages.
- **Module 9:** the Database Explorer, built on the agent's catalog inventory.
- **Module 13:** signed remote commands over the same identity; certificate rotation becomes a remote command.
- Backlog: KMS or HSM for the CA key (SEC-KMS); CRL or OCSP if certificates must be verifiable outside the platform; a public gateway address and TLS termination for production (Module 10 containerization).

## Next module

**Module 8 — Live health monitoring:**
- The agent sends its allow-listed reports over mTLS: PSA integration status, database, containers, CPU, memory and disk, ticket counts, synchronization, versions, backup, and certificate and security status. The outbox is delivered after an outage.
- Strict schemas and a redactor guard what is accepted.
- Centrally configured intervals and thresholds feed a rules engine with the states Healthy, Degraded, Critical, Offline and Unknown.
- Fleet and deployment health pages with timelines.
- *Verified* is set from real checks, and the dashboard KPIs switch from synthetic to real data where it exists.
