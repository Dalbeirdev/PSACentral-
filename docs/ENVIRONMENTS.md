# Environments & Configuration

| | Local development | Test (automated) | Staging | Production |
|---|---|---|---|---|
| `APP_ENV` | `development` | `test` | `staging` | `production` |
| Database | `psacc_dev` (Docker, loopback `:55432`) | `psacc_test` (API integration), `psacc_e2e` (browser E2E) — **dropped and rebuilt every run** | dedicated managed PostgreSQL | dedicated managed PostgreSQL, PITR backups |
| Data | synthetic seed (`is_synthetic = true`) | synthetic seed + isolation tenant | synthetic or anonymized only | real |
| MFA | optional (`AUTH_MFA_REQUIRED=false`) | both modes are tested | **required** (enforced at boot) | **required** (enforced at boot) |
| Cookies | `psacc_session` (HTTP) | same | `__Host-psacc_session`, `Secure` | `__Host-psacc_session`, `Secure` |
| Origins | `http://localhost:3210` | `http://localhost:3310` (E2E) | `https://…` only (enforced) | `https://…` only (enforced) |
| OpenAPI UI | on | off | off unless needed | off |
| Seeding | allowed | allowed | **refused** | **refused** |
| DB login | `psacc_app` | `psacc_app` | app role (never owner/superuser — enforced) | app role (never owner/superuser — enforced) |
| Secrets source | `pnpm setup` (random, gitignored) | same `.env` | secret manager | secret manager / KMS |

## Boot-time guards (`apps/api/src/config/env.ts`)
The API **refuses to start** in staging or production when:
- `AUTH_MFA_REQUIRED` isn't `true`
- any `APP_ALLOWED_ORIGINS` entry isn't `https://`
- `DATABASE_URL` logs in as `postgres` or as a `*_owner` role
- `SEED_DEFAULT_PASSWORD` is set

In every environment it also refuses to start when `CSRF_SECRET` is shorter than 32 bytes or `DATA_ENCRYPTION_KEY` isn't exactly 32 bytes.

## Secret inventory
| Secret | Used by | Rotation |
|---|---|---|
| `CSRF_SECRET` | HMAC for CSRF tokens | Rotate any time. Users must reload their open pages. |
| `DATA_ENCRYPTION_KEY` | AES-256-GCM for MFA seeds (later: PSA credential references) | Envelope is versioned (`v1.`). Rotation requires re-encryption (backlog SEC-KMS). |
| `psacc_app` password | API database login | Standard DB credential rotation |
| `psacc_owner` password | migrations only | Standard DB credential rotation; not present on API hosts in production |
| `POSTGRES_PASSWORD` | dev container bootstrap | Local only |
| `SEED_DEFAULT_PASSWORD` | synthetic dev/test users | Local only |

## Ports (local)
| Service | Port | Notes |
|---|---|---|
| Web (dev) | 3210 | `pnpm dev` |
| API (dev) | 4210 | `/api/v1`, OpenAPI at `/api/docs` |
| PostgreSQL (dev) | 55432 | `127.0.0.1` only, container `psacc-dev-postgres` |
| Web (E2E, production build) | 3310 | started by Playwright |
| API (E2E) | 4310 | started by Playwright |

**Docker lives in WSL on this workstation.** The Ubuntu instance (and with it the Docker daemon and every container, including unrelated stacks) shuts down one to four minutes after the last WSL session closes, even with `vmIdleTimeout` set; the next `wsl --exec` boots it again, which looks like PostgreSQL restarting underneath the tests (`ECONNREFUSED`/`ETIMEDOUT` on `:55432`, `terminating connection due to administrator command` in the API). Keep a WSL terminal (or `wsl --exec bash -c 'sleep 7200'`) open for long test runs, and check `journalctl -u docker` for `daemonShuttingDown=true` when results look like this.

**Host address for appliances.** Appliance containers reach the workstation's agent gateway through the host's LAN address. The Docker suite, the screenshot helpers and `pnpm cp:setup` derive it from the source address of the default route (`ip -4 route get 1.1.1.1`), not from the first entry of `hostname -I`: once other Compose networks exist on the shared engine, that first entry is a Docker bridge (`172.x`) that appliances on their own networks cannot reach. The dev `apps/api/.env` holds `AGENT_GATEWAY_URL` as a fixed value; when the workstation's address changes (Wi-Fi network, VPN), update it and restart the dev API, otherwise packages built by the dev stack enrol against the old address and the real-appliance tests fail at enrollment with empty diagnostics.

## Containerized Control Plane (`infra/control-plane`, Module 10)

| Service | Container | Published | Notes |
|---|---|---|---|
| PostgreSQL 17 | `psacc-cp-postgres` | — | volume `psacc-cp-pgdata`; roles from `infra/dev/postgres-init` |
| Migrations / bootstrap | `psacc-cp-migrate` | — | runs as `psacc_owner`, exits |
| API + agent gateway | `psacc-cp-api` | `127.0.0.1:4410` (API), `0.0.0.0:8643` (gateway, mTLS) | `psacc_app` login, read-only container |
| Web | `psacc-cp-web` | `127.0.0.1:3410` | proxies `/api` to the API service |

`pnpm cp:setup` writes `infra/control-plane/.env` (random secrets, `APP_ENV=development` for a workstation stack). For staging/production set `APP_ENV`, `AUTH_MFA_REQUIRED=true`, `https://` origins, a public `AGENT_GATEWAY_URL` and `EDGE_IMAGE_DIGEST`; the boot-time guards above apply unchanged inside the container. Procedures: `docs/RUNBOOKS.md`.
