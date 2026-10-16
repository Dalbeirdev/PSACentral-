# Runbooks

Operational procedures for the containerized Control Plane (`infra/control-plane`) and the client appliances (deployment packages). Every command below was executed in the Module 10 acceptance test (`docs/reports/MODULE-10.md`).

## 1. Containerized Control Plane

| Task | Command | Notes |
|---|---|---|
| First-time setup | `pnpm cp:setup` | Writes `infra/control-plane/.env` with random secrets (gitignored, never printed). Edit `AGENT_GATEWAY_URL` to the address appliances can reach. |
| Build images | `pnpm cp:build` | `psacc/control-plane-api:<version>` (API, agent gateway, migrations, bootstrap) and `psacc/control-plane-web:<version>` (Next.js standalone). Non-root, read-only root file system, all capabilities dropped. |
| Start | `pnpm cp:up` | PostgreSQL → migrations (as the schema owner, then exits) → API (+ gateway) → web. Web `http://localhost:3410`, API `http://127.0.0.1:4410/api/v1` (loopback only); gateway on `AGENT_GATEWAY_PORT` (8643). |
| First administrator | `pnpm cp:bootstrap` | Creates the organization and Super Administrator from `BOOTSTRAP_*` in `.env`; idempotent; audited as `organization.bootstrapped`. Change the password after the first sign-in. |
| Status / logs | `pnpm cp:status`, `pnpm cp:logs [api\|web\|postgres]` | |
| Stop / start | `pnpm cp:down`, `pnpm cp:up` | Data stays in the `psacc-cp-pgdata` volume. Appliances keep working and buffer their reports while the Control Plane is down; heartbeats and history backfill when it returns. |
| Remove everything | `pnpm cp:destroy` | Removes containers **and the data volume**. Take a backup first. |
| Upgrade | `pnpm cp:build && pnpm cp:up` | The migrate service applies pending migrations before the new API starts. Roll back by restoring the pre-upgrade backup and starting the previous image version (`VERSION=` in `.env`). |

### 1.1 Staging / production hardening
Set `APP_ENV=staging|production`, `AUTH_MFA_REQUIRED=true`, `https://` origins only, a public `AGENT_GATEWAY_URL`, and `EDGE_IMAGE_DIGEST` of the signed edge image. The API refuses to boot otherwise (`docs/ENVIRONMENTS.md`). Terminate TLS for the web origin in a reverse proxy in front of `web` (the stack publishes web and API on loopback only); the agent gateway terminates its own TLS (mTLS) and must be reachable from client networks. Inject the `.env` values from a secret manager.

## 2. Control Plane backup and restore

**Backup** — `pnpm cp:backup` runs `pg_dump -Fc` inside the PostgreSQL container and writes `infra/control-plane/backups/psacc-<UTC timestamp>.dump` plus a `.sha256`. The dump contains everything the Control Plane holds: organizations, users (password hashes), clients, PSA instances (no credentials — they live on the appliances), deployments, the internal CA (private key encrypted with `DATA_ENCRYPTION_KEY`), agent certificates, health history and database metadata. **Keep `DATA_ENCRYPTION_KEY` and `CSRF_SECRET` from `.env` with the backup**: without the key, the CA and every encrypted value in the dump are unusable.

**Restore** — `pnpm cp:restore infra/control-plane/backups/<file>.dump`:
1. verifies the checksum when the `.sha256` sits next to the file;
2. stops `web` and `api`;
3. drops and recreates the `psacc` database with the owner/grant layout of a fresh install;
4. `pg_restore --no-owner --role=psacc_owner`;
5. runs pending migrations (a backup from an older version is upgraded on restore);
6. starts `api` and `web`.

Appliances are unaffected: they keep their certificates and buffer reports during the restore window. Anything created after the backup (clients, deployments, packages) is gone; an appliance enrolled after the backup must be re-enrolled with a new package.

**Schedule**: daily at minimum, before every upgrade, and before `cp:destroy`. Copy the dump and its checksum off the host.

## 3. Appliance (client deployment) backup and restore

Each appliance's `edge-backup` service runs `pg_dump -Fc` of its own database into the `<project>_edge-backups` volume on the interval in its `.env` (`EDGE_BACKUP_INTERVAL_HOURS`, default 24; `EDGE_BACKUP_RETENTION`, default 7). Every run is recorded in `backup_runs` with size and SHA-256 and reported to the Control Plane as status only (never content). The Health page shows the last backup; a failed or stale backup degrades the deployment.

**Copy a backup off the host** (run on the client's host, in the package directory):
```bash
docker compose cp edge-backup:/backups/ ./backups-copy/
```

**Restore into a fresh installation of the same package** (same deployment identity):
1. `docker compose down` (keep volumes) or install the package again on replacement hardware with the same `secrets/`;
2. `docker compose up -d edge-postgres` and wait for `healthy`;
3. `docker compose cp ./psa_edge-<timestamp>.dump edge-postgres:/tmp/restore.dump`;
4. `docker compose exec edge-postgres sh -c 'PGPASSWORD="$(cat /run/secrets/postgres_owner_password)" pg_restore -h 127.0.0.1 -U psa_edge_owner -d psa_edge --clean --if-exists --no-owner --role=psa_edge_owner /tmp/restore.dump'`;
5. `docker compose up -d` — `edge-migrate` applies anything newer than the dump, the agent reconnects with the existing certificate.

The dump contains PSA credentials **encrypted with the host key** in `secrets/`; a dump restored on a host without the original `secrets/` keeps the data but the credentials must be re-entered in the local admin UI. Never copy `secrets/` and dumps to the same off-site location.

## 4. Edge image for air-gapped clients (OPS-IMGEXPORT)

`pnpm edge:export` writes `dist/edge/psa-edge-<version>.tar` with `.sha256` and `.image-id`. Ship the archive with the deployment package; on the client host:
```bash
sha256sum -c psa-edge-<version>.tar.sha256
docker load -i psa-edge-<version>.tar
docker image inspect psacc/psa-edge:<version> --format '{{.Id}}'   # must equal the .image-id file
```
then run the package's `install.sh` as usual. Registry publication with cosign signatures and digest pinning (`EDGE_IMAGE_DIGEST`) remains backlog OPS-REGISTRY; until then the image ID check above is the integrity control.

## 5. Agent certificate incidents

- **Compromised or replaced appliance**: Deployment → Settings → *Revoke agent certificate* (audited). The gateway refuses the old certificate immediately; generate a new package to re-enroll.
- **Expired certificate** (agent offline for longer than the certificate lifetime): the deployment shows *Offline*; re-enroll with a new package.
- **Re-enrolling an installed appliance in place** (same host, same data): generate the new package, replace `enrollment/enrollment.json`, `config/edge.json` and `config/license.json` in the package folder (they are mode 444: replace them, do not edit in place, and leave the copies world-readable — the containers run as their own user), clear the agent state volume, then `docker compose up -d --force-recreate` — a plain restart keeps the old files, because a file bind mount follows the inode it was created with. The helper on Windows (`Install-EdgePackage.ps1 -Zip`) does this for you.
- **Rotation**: automatic after two thirds of the lifetime; no action needed.

## 6. PSA credentials and connection tests (Module 11)

1. Open the appliance's local admin page on the Docker host (`http://127.0.0.1:<port>`, port = 18000 + deployment number) and sign in as the local administrator.
2. **Credentials** → enter the fields the PSA instance's authentication method requires (shown by label; secrets are masked). They are encrypted with the host's data key and stored in the appliance database only.
3. For an on-premise PSA with a private CA, paste the CA certificate (PEM) in *Private CA certificate*. Public PSAs need nothing here.
4. Press **Test connection now**. The appliance authenticates against the PSA API and reads one record. The outcome is shown inline: `ok`, or a code such as `auth_failed` (HTTP 401: wrong credentials), `forbidden` (HTTP 403: the API user lacks rights), `not_found` (wrong zone / endpoint), `tls_error` (private CA missing), `endpoint_unreachable` (firewall / DNS), `timeout`, `rate_limited`.
5. The outcome reaches the Control Plane with the agent's next report (≤ 1 minute): the PSA instance shows *Verified* / *Test failed*, the Integrations page lists it, and the deployment's health shows `psa_failed` while a test fails. The worker repeats the test every 15 minutes (`PSA_EDGE_PSA_TEST_INTERVAL` in the appliance `.env`), so revoked credentials surface by themselves.
6. Rotating credentials: enter the new values (fields left empty keep their value) and test again. The Control Plane never receives credentials; it cannot be used to recover them.

## 7. Ticket synchronization (Module 12)

1. Prerequisite: the PSA connection is *verified* (section 6). The worker then synchronizes every `PSA_EDGE_SYNC_INTERVAL` (default 5 m; set it in the appliance `.env` and `docker compose up -d`).
2. **Synchronization** page on the appliance: *Sync now* for an immediate run; the run row shows received / sent / failed counts, pages and an error code when something failed (`auth_failed`, `endpoint_unreachable`, `timeout`, `rate_limited`, `server_error`, `push_failed`, `sync_unsupported`, `psa_not_verified`).
3. Failed runs back off (doubling to 30 min) and recover by themselves; `partial` means the PSA was read but some local changes could not be pushed — open the ticket's timeline for the push error, fix the cause (usually a status the board does not have, or permissions) and the next run retries.
4. Conflicts: when the PSA changed a ticket's status while a local change waited, the PSA's status wins; the ticket shows `conflict` and a `sync_conflict` event with both statuses. Re-apply the local change if it still applies.
5. Tickets raised on the appliance reach the PSA only through the custom REST adapter; with Autotask or ConnectWise they stay `local_only` until a company / board mapping exists (planned).
6. What the Control Plane sees: counts and statuses on the deployment health page, the PSA instance page and Integrations. For ticket content, use the appliance's own pages or its database backups (section 3).

## 8. Remote operations and upgrades (Module 13)

1. **Issue a command**: Deployment → *Operations* → choose a card → review → *Issue command*. The agent fetches it with its next heartbeat (every 15–60 s by policy); the row moves to *Delivered* and then to the appliance's answer. One open command per type; pending commands can be cancelled; open commands expire after the chosen window (15 min – 24 h) and are audited as expired.
2. **What each command does on the appliance**: *Refresh health now* (agent collects and delivers at once), *Test PSA connection* (worker runs the real test; result code / HTTP / latency), *Run synchronization* (one pass; counts in the answer), *Restart a service* (the service exits cleanly, Compose starts it again — no data loss; restarting `edge-agent` reports first, then exits), *Rotate machine certificate* (new key and certificate; the old serial shows *Replaced by renewal*).
3. **Upgrade an appliance**: *Upgrade appliance image* targets the Control Plane's standard image (`EDGE_IMAGE_VERSION` / `EDGE_IMAGE_DIGEST`; production requires a digest). The command ends *Staged — waiting for the host operator*. On the appliance host, from the package directory: `scripts/upgrade.sh` (Windows: `scripts\upgrade.ps1`). It pulls the image, checks the digest, records `PSA_EDGE_IMAGE` in `.env` and recreates the services; data volumes and secrets stay. The new agent reports *Succeeded* with its version; the Operations header shows *up to date*. Roll back with `scripts/upgrade.sh --image <previous image>`. Air-gapped hosts: `docker load -i` the exported image first (`pnpm edge:export`).
4. **A command failed**: the answer's code says why — `no_response` (the target service is not running or runs an image without remote command support; check `docker compose ps`), `bad_signature` / `unknown_key` / `target_mismatch` (the agent refused it: do not retry blindly; check the activity log and the Control Plane's signing key on Operations), `type_not_allowed`, `repository_mismatch` (the standard image repository differs from the package's), `renewal_failed`, `delivery_failed`.
5. **Agents enrolled before Module 13** pin the signing key on their first heartbeat after the appliance image is upgraded (they need an image with remote command support first; use the package's `scripts/upgrade.sh --image …`).
6. **Not possible remotely, by design**: suspend, revoke, decommission, uninstall (Modules 14–15), anything with the Docker socket, shell access.

## 9. Licenses, suspension and lifecycle (Module 14)

1. **Create a license**: Licenses → *New license* (client, plan, term, maximum deployments). New deployments of the client bind to the active license with free capacity automatically; drafts can be re-bound in Settings. A deployment without a license cannot get a package (readiness check *Active license with capacity*).
2. **Expiry**: licenses past their end date become *expired* on the hourly sweep (audited `license.expired`); until then readers already show them as expired. Running appliances keep working; their health shows `license_inactive` (degraded) and, 30 days before, `license_expiring`. Extend the term on the edit page to reactivate; new packages work again at once.
3. **Suspend a deployment** (Overview → *Suspend deployment*, reason required): the record becomes *Suspended*; packages, enrollment and operator commands stop; an enrolled appliance receives a signed `suspend` command within a heartbeat — its worker pauses PSA tests and synchronization, the local admin shows the banner, tickets and data stay. **Resume** restores the previous state and sends `resume`; a pending *Sync now* then runs. Both actions are audited (`deployment.suspended` / `.resumed`) and visible on the Operations history.
4. **Suspend or revoke a license** (license page): blocks packages and enrollment for every bound deployment; appliances already running are not changed — suspend them individually if the contract requires it. Revocation is final.
5. **Capacity**: *full* means every slot is bound; raise the limit on the edit page (it cannot go below the current usage) or decommission deployments (Module 15).


## 10. Decommissioning and removal (Module 15)

1. **Decide first whether it is final.** Suspension (§9) is reversible; decommissioning is not. A decommissioned deployment cannot be resumed; a new deployment with a new identity would be needed.
2. **Decommission in the dashboard** (deployment Overview → *Decommission (final)…*): give the reason, type the deployment ID. The Control Plane revokes the machine certificate, the enrollment token and the usable package, cancels open commands, frees the license slot and audits `deployment.decommissioned`. The appliance notices at its next heartbeat (the gateway answers `410 decommissioned`), stops PSA tests and synchronization, logs it, and shows *Decommissioned by the provider* with the removal instructions. **Nothing on the host is changed or deleted.**
3. **Remove on the host** (the client's operator, from the package folder): `scripts/uninstall.sh` stops the appliance and keeps the data; `scripts/uninstall.sh --wipe --confirm DEP-nnnnn` (Windows: `scripts\uninstall.ps1 -Wipe -Confirm DEP-nnnnn`) deletes the volumes, `./secrets` and `.env` and verifies that nothing of the project remains. The script refuses to wipe while the agent still reports an active identity; `--force` overrides that only when the Control Plane is unreachable for good. Take a backup first if the data may still be needed (§3).
4. **Retention** (Settings → Data retention): the Control Plane keeps reports, heartbeats, inventory, health events and commands of decommissioned deployments for the policy period (default 90 days), then the hourly sweep purges them (audit `deployment.metadata.purged`). *Purge what is due now* runs the sweep immediately. The record, its certificate history and the audit trail stay.
5. **Remove the record** (Overview → *Remove from the Control Plane*, typed ID) once the host is clean or the data is no longer needed: deletes the record and everything the Control Plane still holds about it; `deployment.removed` on the client's activity keeps the counts and the certificate serials. Afterwards the deployment URL is a 404 and the retired certificate is unknown to the gateway.
6. **Not possible remotely, by design**: uninstall, wipe, shutdown. If a host must be cleaned without its operator, that is an organisational matter, not a Control Plane feature.

## 11. License tokens (Module 16)

1. **Keys.** `LICENSE_SIGNING_KEY` in the API's environment signs every token; losing it means rebuilding images and regenerating packages. Back it up with the other secrets. The public key (Settings → `GET /settings/licensing-key`, or `openssl` from the seed as `scripts/vps/cp.sh build` does) must be pinned into every edge image: `pnpm edge:build` and `cp.sh build` do that automatically. A key rotation = new seed → rebuild and republish the image (clients upgrade through Module 13) → regenerate packages for not-yet-enrolled deployments; enrolled appliances receive tokens signed with the new key at their next heartbeat but verify them with the old pinned key until they run the new image — rotate only together with an image roll-out.
2. **An appliance shows "License token revoked / expired / missing"**: check the deployment's license on the Licenses page (status, end date) and the deployment (suspended?). Fix the cause (resume the license, extend the term, resume the deployment); the next heartbeat renews the token and PSA work resumes within a worker tick. No reinstall.
3. **"Invalid token" or "Token for another appliance"**: the package was copied to another host, or `/var/log/psa-edge/license/current.json` was altered. The next heartbeat overwrites it with a fresh token; if it persists, the image was built with a different key than the Control Plane's (`keyId` on the status page vs `GET /settings/licensing-key`) — rebuild the image with `cp.sh build` / `pnpm edge:build` and upgrade.
4. **Control Plane outage**: appliances keep working for 30 days (token) + 14 days (grace); the status page shows *grace* with the deadline. Restore the Control Plane before the grace ends; nothing else is needed.
5. **Old packages** (before Module 16) keep working against an upgraded Control Plane: the first heartbeat delivers the token.

## 12. A client deleted a deployment from the appliance (Module 17)

1. **What you see.** The deployment is gone from the dashboard; *Activity & audit logs* → category *Deleted by clients* shows `deployment.deleted_by_client` on the client with who asked on the appliance, the reason, the installation id, the certificate serials and the rows deleted. Nothing else about the deployment exists any more; the license seat is free.
2. **Nothing to do on the Control Plane.** The client's host operator finishes with `scripts/uninstall.sh --wipe --confirm DEP-nnnnn` (no `--force` needed). If the client wants the service again, onboard a new deployment: identities are never reused.
3. **The appliance says "refused".** Its certificate was revoked, superseded or expired on the Control Plane, so the deletion could not be authenticated. Either the client deletes locally anyway (the page offers it; then remove the record yourself: decommission → remove, or let retention purge it), or re-enroll first if the service is to continue.
4. **The appliance is stuck in "deregistering".** It cannot reach the gateway; it retries every up to five minutes and deletes nothing meanwhile. Check the gateway address and the client's egress; the audit event appears the moment the request gets through.
5. **Honest limits.** The appliance cannot remove its own containers and volumes (no Docker access by design) — the status page says so and names the command. Backups in the backups volume are removed by that command, not by the appliance.
