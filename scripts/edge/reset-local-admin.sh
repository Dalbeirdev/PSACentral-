#!/usr/bin/env bash
# Reset the local administrator of a PSA Edge appliance installed on this machine by the Windows helper
# (scripts/edge/Install-EdgePackage.ps1 / psa-edge.cmd).
#
# Removes the named local admin account (or every local admin when no name is given) together with its
# sessions, so the appliance shows its first-run setup page again at http://localhost:18nnn/setup.
# Tickets, PSA credentials, the enrollment and the license are not touched. Nothing is printed but counts.
#
# Run from Command Prompt or PowerShell (root inside WSL, where the appliance lives):
#   wsl -u root -- bash "/mnt/e/PSA COntrole center/scripts/edge/reset-local-admin.sh" DEP-00030
#   wsl -u root -- bash "/mnt/e/PSA COntrole center/scripts/edge/reset-local-admin.sh" DEP-00030 harpal
set -euo pipefail
code="${1:?usage: reset-local-admin.sh DEP-nnnnn [username]}"
user="${2:-}"
dir="/opt/psa-edge/psacc-$(printf '%s' "$code" | tr '[:upper:]' '[:lower:]')"
[ -f "$dir/compose.yaml" ] || { echo "No appliance for $code at $dir." >&2; exit 1; }
cd "$dir"
where=""
if [ -n "$user" ]; then where="WHERE username = '${user//\'/\'\'}'"; fi
docker compose exec -T edge-postgres sh -c 'PGPASSWORD="$(cat /run/secrets/postgres_owner_password)" psql -h 127.0.0.1 -U psa_edge_owner -d psa_edge -v ON_ERROR_STOP=1 -qtAX' <<SQL
DELETE FROM local_admin_sessions;
DELETE FROM local_admin_users $where;
SELECT 'Remaining local admin accounts: ' || count(*) FROM local_admin_users;
SQL
num="${code//[!0-9]/}"
echo "Done. Open http://localhost:$((18000 + 10#$num % 1000))/setup and create the administrator again."
