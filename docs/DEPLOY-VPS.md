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

## 5b. Option A — sharing the PioDesk VPS (ports 8443 / 8643), decided 2026-10-20

The Control Plane can run on the VPS that already hosts PioDesk without touching PioDesk: PioDesk's nginx
keeps ports 80 and 443, the Control Plane takes `https://techpio.tech:8443` (dashboard) and `:8643`
(agent gateway). What changes compared with the dedicated-VPS procedure above:

| Step | Dedicated VPS | Shared VPS (coexistence) |
|---|---|---|
| Prepare | `cp-vps-setup.sh` | `PSACC_COEXIST=1 cp-vps-setup.sh` — Docker is reused if present; the firewall is only *added to* (8443, 8643) and only when ufw is already active; the script asks for a **Hostinger API token** (panel → Account → API; input hidden, stored in `.env` mode 600) |
| DNS | `A` records → the new VPS | nothing: `techpio.tech` already points at this VPS |
| Certificate | `cp.sh cert` (HTTP-01 on port 80) | `cp.sh dns-test` once (creates and removes one `_psacc-dns-test` TXT record to prove the token), then `cp.sh cert` — Let's Encrypt **DNS-01** through the Hostinger DNS API (`scripts/vps/hostinger-dns-hook.py`, standard library only, token never printed); renewal by the certbot sidecar the same way |
| Edge | nginx on 80/443 | `compose.coexist.yaml` overlay: nginx on **8443 only** (`PSACC_HTTPS_PORT`; pick another free port if 8443 is taken on that server), no HTTP listener, no redirect |
| URLs | `https://techpio.tech` | `https://techpio.tech:8443` (allowed origins carry the port); appliances dial `https://techpio.tech:8643` as before |
| Everything else | — | unchanged: build, push-edge, up, bootstrap, backup, update, status (`cp.sh status` checks the configured port) |

Rehearsed on the workstation on 2026-10-20 (on 9443, because 8443 is the development gateway there): the merged
Compose configuration publishes only the HTTPS port for the edge, the stack came up with a self-signed certificate, sign-in with the `:8443` origin
succeeded and a plain-http origin was refused, and the certbot sidecar runs with the DNS hook mounted.
The hook itself is exercised against a fake Hostinger API (request shapes, relative record names for the
apex and `www`, authorization header, cleanup leaving the zone as found, failure messages without the
token). The real API call is proven on the VPS by `cp.sh dns-test` before any certificate is attempted.

What stays shared and what does not: CPU, memory and disk of the VPS are shared with PioDesk (watch
`free -m` and `df -h` after the first weeks); nothing else is — separate Compose project, networks,
volumes, database and ports. Removing the Control Plane later is `cp.sh down` plus deleting the
`psacc-cp-*` volumes; PioDesk is unaffected throughout.

## 6. Day-to-day

| Task | Command |
|---|---|
| Logs | `scripts/vps/cp.sh logs [api\|web\|edge\|postgres]` |
| Backup | `scripts/vps/cp.sh backup` → `infra/control-plane/backups/psacc-<utc>.dump` + `.sha256`; copy them off the VPS (cron it daily) |
| Restore | `scripts/vps/cp.sh restore <file.dump>` (stops web and API meanwhile) |
| Update to a new commit | `scripts/vps/cp.sh update` (pull, rebuild, migrate, restart); re-run `push-edge` when the appliance image changed |
| Certificate renewal | automatic (certbot sidecar, nginx reloads every 6 h); `status` shows the dates |
| Stop everything | `scripts/vps/cp.sh down` (data stays in the `psacc-cp-pgdata` volume) |

## Rehearsed on a workstation (2026-10-16)

The whole procedure was run on the development machine before any VPS existed, with the same scripts
(`PSACC_SKIP_FIREWALL=1`, the machine's address as the domain, `cp.sh cert --self-signed`, a local
registry instead of GHCR): setup, build, push with digest pinning, start, bootstrap, MFA sign-in in
production mode, onboarding, a real appliance installed with the production overlay and enrolled over
the public gateway address, decommissioning, host-side wipe and removal. Evidence:
`docs/reports/vps-rehearsal/` (`rehearsal.json`, `uninstall-sh-output.txt`, screenshots). Two things
it surfaced, both by design:

- a client host installing with `scripts/install.sh --production` must set `PSA_POSTGRES_IMAGE` (the
  PostgreSQL image pinned by digest) in the package's `.env`, next to the already pinned edge image;
- in production the API's cookies carry the `__Host-` prefix; browsers handle that transparently, scripts
  must look the cookie up by suffix.

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
