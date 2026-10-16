# Demo on your own machine: onboard a client and run its appliance

Everything stays on this computer: the Control Plane is the development stack, and the client's
appliance runs in WSL's Docker Engine. No Docker Desktop is needed. Nothing is public.

## 0. Start the Control Plane (once per session)

In the Claude Code app the two dev servers are started as previews (`api` on 4210, `web` on 3210).
From a terminal instead:

```powershell
cd "E:\PSA COntrole center"
pnpm --filter @psacc/api dev      # one terminal
pnpm --filter @psacc/web dev      # another terminal
```

Dashboard: `http://localhost:3210`. Sign in as `avery.admin@psacc.test` with the seed password from
`apps/api/.env` (`SEED_DEFAULT_PASSWORD`). The sample organization (synthetic clients) is there for
context; your own clients sit next to them.

## 1. Onboard the client (dashboard)

Clients → *Onboard client* → the ten-step wizard: company, contacts, PSA provider, PSA
configuration, services, deployment target, review, create. For a demo appliance on this machine
choose **Local testing environment**, Linux, amd64 in the deployment step. Step 7 creates the
client, its PSA instance, its first license and the deployment record; step 8 generates and
downloads the package (`psacc-dep-nnnnn-package-n.zip`, token valid for the chosen hours).

## 2. Install the appliance (one PowerShell command)

```powershell
cd "E:\PSA COntrole center"
.\scripts\edge\Install-EdgePackage.ps1 -Zip "$env:USERPROFILE\Downloads\psacc-dep-00030-package-1.zip"
```

The helper unpacks the package into WSL (`/opt/psa-edge/psacc-dep-nnnnn`), runs the package's own
`scripts/install.sh` and `scripts/verify.sh` there, and prints the local admin URL. Within a minute
the dashboard shows the deployment as **Enrolled**, then **Verified** once the first health reports
pass.

Why not `scripts\install.ps1` from the package: that one expects Docker Desktop on Windows. On this
machine Docker lives inside WSL, so the helper drives it there. On a client's real Windows host with
Docker Desktop, the package's own `install.ps1` is the right tool.

## 3. The appliance's local admin

`http://localhost:18nnn` (the port is printed by the helper; it is 18000 + the deployment number).
First visit: create the local administrator. Then *PSA credentials*: enter the client's PSA API
credentials there (they never leave the appliance) and run the connection test. Tickets and
synchronization pages fill once the PSA connection is verified; for ConnectWise or Autotask that
needs real credentials, so for a demo without them the appliance shows *not configured* honestly.

## 4. What to show in the dashboard

- Deployment → Overview: lifecycle tracker, identity card (deployment, installation, license IDs),
  machine certificate.
- Health: live findings from the appliance's reports; Database: the appliance's table inventory.
- Operations: signed remote commands (refresh, PSA test, sync, restart, certificate rotation).
- Licenses, suspension (Overview → *Suspend deployment*) and the final decommissioning page.

## 5. Day-to-day on this machine

```powershell
.\scripts\edge\Install-EdgePackage.ps1 -Status DEP-00030    # containers, agent state, verify checks
.\scripts\edge\Install-EdgePackage.ps1 -Stop   DEP-00030    # stop, keep data (install again to resume)
.\scripts\edge\Install-EdgePackage.ps1 -Wipe   DEP-00030    # remove everything on this machine (asks to type the ID)
```

Decommission or remove the deployment in the dashboard when the demo is over; wiping the appliance
alone does not retire its identity on the Control Plane.

## If something is off

- *Not enrolled* after a few minutes: check `apps/api/.env` → `AGENT_GATEWAY_URL` must carry this
  machine's current address (`wsl -- ip -4 route get 1.1.1.1`); the workstation's address changes
  between networks. Fix it, restart the API, and run the install helper again (idempotent).
- *Token expired*: generate a new package in the dashboard (the old one is revoked) and install it.
- Port 18nnn busy: set `EDGE_LOCAL_ADMIN_PORT` in `/opt/psa-edge/psacc-dep-nnnnn/.env` and re-run
  the helper.
