# Deploying the Control Plane to a dedicated VPS (techpio.tech)

The PSA Control Center runs on its **own** VPS. It is never installed next to PioDesk: PioDesk's
edge owns ports 80 and 443 on its server, and nothing of PioDesk is changed by this procedure.
The client appliances (PSA Edge) still run in each client's Docker environment; the VPS hosts only
the management plane (dashboard, API, agent gateway, PostgreSQL metadata).

What you need:

| Item | Value |
|---|---|
| VPS | Hostinger KVM (same account as PioDesk), Ubuntu 24.04, 2 vCPU / 4 GB RAM / 40 GB minimum; root SSH |
| Domain | `techpio.tech` (DNS already at Hostinger). A record of `techpio.tech` **and** `www` → the new VPS address |
| Ports open | 22 (SSH), 80 and 443 (dashboard, certificates), 8643 (agent gateway, mutual TLS) — the setup script configures ufw |
| Registry | A place client hosts can pull the PSA Edge image from, e.g. GitHub Container Registry `ghcr.io/dalbeirdev/psa-edge` (a personal access token with `write:packages` on the VPS to push; client hosts need pull access) |

Everything runs in Docker; the host needs no Node, pnpm or Go.

## 1. Prepare the server

As root on the fresh VPS:

```bash
curl -fsSL https://raw.githubusercontent.com/Dalbeirdev/PSACentral-/main/scripts/vps/cp-vps-setup.sh | sudo bash
```

Installs Docker Engine + Compose, configures ufw, clones the repository to `/opt/psacc` and writes
`/opt/psacc/infra/control-plane/.env` with production settings and random secrets (asks only for the
administrator e-mail). The file is mode 600 and is never committed. Re-running keeps an existing `.env`.

Defaults can be overridden with environment variables before the pipe: `PSACC_DOMAIN`,
`PSACC_ADMIN_EMAIL`, `PSACC_EDGE_IMAGE_REPOSITORY`, `PSACC_GATEWAY_PORT`, `PSACC_DIR`.

## 2. Point the domain at the server

In Hostinger's DNS zone for `techpio.tech`: set the **A** record of `@` to the new VPS address and keep
`www` as a CNAME to `@` (or an A record to the same address). Wait until both resolve to the new
address (`getent ahostsv4 techpio.tech`); Let's Encrypt validates by HTTP, so the record must be live.

Until the record changes, `techpio.tech` still reaches the PioDesk server and shows PioDesk's
certificate — that is the current state, not an error on the new VPS.

## 3. Build the images

```bash
cd /opt/psacc && scripts/vps/cp.sh build
```

Builds `psacc/control-plane-api`, `psacc/control-plane-web` and the appliance image
(`EDGE_IMAGE_REPOSITORY:VERSION`, default `ghcr.io/dalbeirdev/psa-edge:0.1.0`) from the checkout.

## 4. Publish the appliance image and pin its digest

Client packages reference the edge image by repository, version and **digest**; production refuses to
start until the digest is known (boot-time guard, `docs/ENVIRONMENTS.md`).

```bash
docker login ghcr.io -u Dalbeirdev        # token with write:packages
scripts/vps/cp.sh push-edge               # pushes the image and writes EDGE_IMAGE_DIGEST into .env
```

Client hosts pull the image with `docker compose pull` during `scripts/install.sh`; keep the package
public on GHCR or give each client a read-only pull token (documented in the package's INSTALL.md).

## 5. Certificate, start, first administrator

```bash
scripts/vps/cp.sh cert        # Let's Encrypt for techpio.tech and www (checks DNS first)
scripts/vps/cp.sh up          # PostgreSQL → migrations → API + gateway → web → edge + certbot
scripts/vps/cp.sh bootstrap   # first organization and administrator (idempotent, audited)
scripts/vps/cp.sh status      # containers, health endpoints, certificate dates
```

Sign in at `https://techpio.tech` with `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD` from
`.env` (`sudo grep BOOTSTRAP_ADMIN_PASSWORD /opt/psacc/infra/control-plane/.env`). MFA enrolment is
mandatory in production; change the password afterwards. The agent gateway answers on
`https://techpio.tech:8643` with the platform CA's certificate (pinned by every package, so no
public certificate is involved there).

## 6. Day-to-day

| Task | Command |
|---|---|
| Logs | `scripts/vps/cp.sh logs [api\|web\|edge\|postgres]` |
| Backup | `scripts/vps/cp.sh backup` → `infra/control-plane/backups/psacc-<utc>.dump` + `.sha256`; copy them off the VPS (cron it daily) |
| Restore | `scripts/vps/cp.sh restore <file.dump>` (stops web and API meanwhile) |
| Update to a new commit | `scripts/vps/cp.sh update` (pull, rebuild, migrate, restart); re-run `push-edge` when the appliance image changed |
| Certificate renewal | automatic (certbot sidecar, nginx reloads every 6 h); `status` shows the dates |
| Stop everything | `scripts/vps/cp.sh down` (data stays in the `psacc-cp-pgdata` volume) |

## What is exposed

```
Internet ──443──> psacc-cp-edge (nginx, Let's Encrypt) ──> psacc-cp-web (Next.js) ──/api──> psacc-cp-api
Internet ──80───> psacc-cp-edge (ACME challenge, redirect to HTTPS)
Agents  ──8643──> psacc-cp-api agent gateway (mutual TLS, platform CA, not proxied)
                  psacc-cp-postgres: not published
```

Any other host name on the address is dropped (HTTP 444): the server never serves another site's
content for a stray domain.

## Rollback

`scripts/vps/cp.sh down`, `git -C /opt/psacc checkout <previous commit>`, `scripts/vps/cp.sh build`,
`scripts/vps/cp.sh up`. Migrations are forward-only; restore a backup taken before the update if the
schema must go back.
