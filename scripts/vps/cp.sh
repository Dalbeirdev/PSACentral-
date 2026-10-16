#!/usr/bin/env bash
# PSA Control Center — operations on a dedicated Linux VPS (no Node or pnpm needed on the host).
# Runs the containerized Control Plane (infra/control-plane) with the public edge overlay.
#
# Usage: scripts/vps/cp.sh <command>
#   build            build psacc/control-plane-api, -web and psacc/psa-edge from this checkout
#   cert             issue the first Let's Encrypt certificate for PSACC_DOMAIN (port 80 must be free)
#   up | down        start / stop the stack (PostgreSQL, migrations, API + gateway, web, edge, certbot)
#   status           containers, health endpoints and certificate dates
#   logs [service]   follow logs
#   bootstrap        create the first organization and administrator (idempotent)
#   push-edge        push the edge image to EDGE_IMAGE_REPOSITORY and record its digest in .env
#   backup           pg_dump of the psacc database into ./backups (with sha256)
#   restore <file>   restore a backup (stops web/api meanwhile)
#   update           git pull, rebuild, migrate and restart
#   psql             psql as the schema owner
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CP="$ROOT/infra/control-plane"
ENV_FILE="$CP/.env"
cd "$CP"

env_get() { sed -n "s/^$1=//p" "$ENV_FILE" | head -n 1; }
need_env() { [ -f "$ENV_FILE" ] || { echo "ERROR: $ENV_FILE is missing. Run scripts/vps/cp-vps-setup.sh first." >&2; exit 1; }; }
compose() { docker compose --env-file "$ENV_FILE" -f compose.yaml -f compose.public.yaml "$@"; }
step() { printf '\n==> %s\n' "$1"; }

cmd="${1:-}"; shift || true
case "$cmd" in
  build)
    need_env
    VERSION="$(env_get VERSION)"; VERSION="${VERSION:-0.1.0}"
    EDGE_REPO="$(env_get EDGE_IMAGE_REPOSITORY)"; EDGE_REPO="${EDGE_REPO:-psacc/psa-edge}"
    step "Building psacc/control-plane-api:$VERSION"
    docker build -f "$ROOT/apps/api/Dockerfile" -t "psacc/control-plane-api:$VERSION" --build-arg "VERSION=$VERSION" "$ROOT"
    step "Building psacc/control-plane-web:$VERSION"
    docker build -f "$ROOT/apps/web/Dockerfile" -t "psacc/control-plane-web:$VERSION" --build-arg "VERSION=$VERSION" "$ROOT"
    step "Building the PSA Edge appliance image $EDGE_REPO:$VERSION (what client packages reference)"
    docker build -f "$ROOT/apps/edge/Dockerfile" -t "$EDGE_REPO:$VERSION" --build-arg "VERSION=$VERSION" "$ROOT/apps/edge"
    docker image ls --format 'table {{.Repository}}\t{{.Tag}}\t{{.Size}}' | grep -E 'control-plane|psa-edge' || true
    ;;
  cert)
    need_env
    DOMAIN="$(env_get PSACC_DOMAIN)"; EMAIL="$(env_get LETSENCRYPT_EMAIL)"
    [ -n "$DOMAIN" ] && [ -n "$EMAIL" ] || { echo "ERROR: PSACC_DOMAIN and LETSENCRYPT_EMAIL must be set in .env" >&2; exit 1; }
    step "Checking that $DOMAIN resolves to this host"
    MINE="$(curl -4 -s --max-time 10 https://api.ipify.org || true)"; THEIRS="$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}')"
    echo "  this host: ${MINE:-unknown}   $DOMAIN: ${THEIRS:-unresolved}"
    if [ -n "$MINE" ] && [ "$MINE" != "$THEIRS" ]; then echo "ERROR: DNS does not point here yet; Let's Encrypt would fail. Fix the A record first." >&2; exit 1; fi
    step "Issuing the certificate with certbot (standalone on port 80)"
    compose stop edge 2>/dev/null || true
    docker run --rm -p 80:80 -v psacc-cp-letsencrypt:/etc/letsencrypt certbot/certbot certonly --standalone --non-interactive --agree-tos --no-eff-email \
      -m "$EMAIL" -d "$DOMAIN" -d "www.$DOMAIN"
    echo "Certificate issued for $DOMAIN and www.$DOMAIN; start the stack with: scripts/vps/cp.sh up"
    ;;
  up)
    need_env
    step "Starting the Control Plane"
    compose up -d
    compose ps
    ;;
  down)
    need_env; compose down ;;
  status)
    need_env
    DOMAIN="$(env_get PSACC_DOMAIN)"
    compose ps
    step "Health"
    printf '  API live:     '; curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:$(env_get API_PORT)/api/v1/health/live" || true
    printf '  Dashboard:    '; curl -s -o /dev/null -w '%{http_code}\n' "https://$DOMAIN/login" || true
    printf '  Agent gateway: '; curl -sk -o /dev/null -w '%{http_code}\n' "https://$DOMAIN:$(env_get AGENT_GATEWAY_PORT)/agent/v1/health" || true
    step "Certificate"
    docker run --rm -v psacc-cp-letsencrypt:/etc/letsencrypt:ro certbot/certbot certificates 2>/dev/null | grep -E 'Domains|Expiry' || echo "  (none yet: run scripts/vps/cp.sh cert)"
    ;;
  logs)
    need_env; compose logs -f --tail 200 "$@" ;;
  bootstrap)
    need_env
    step "Creating the first organization and administrator (idempotent)"
    compose run --rm --no-deps migrate node dist/database/cli.js bootstrap
    ;;
  push-edge)
    need_env
    VERSION="$(env_get VERSION)"; EDGE_REPO="$(env_get EDGE_IMAGE_REPOSITORY)"
    step "Pushing $EDGE_REPO:$VERSION (log in first: docker login <registry>)"
    docker push "$EDGE_REPO:$VERSION"
    DIGEST="$(docker image inspect "$EDGE_REPO:$VERSION" --format '{{index .RepoDigests 0}}' | sed 's/.*@//')"
    [ -n "$DIGEST" ] || { echo "ERROR: no repository digest found after the push" >&2; exit 1; }
    sed -i "s|^EDGE_IMAGE_DIGEST=.*|EDGE_IMAGE_DIGEST=$DIGEST|" "$ENV_FILE"
    echo "EDGE_IMAGE_DIGEST set to $DIGEST in .env — restart the API to use it: scripts/vps/cp.sh up"
    ;;
  backup)
    need_env
    mkdir -p "$CP/backups"; chmod 700 "$CP/backups"
    F="$CP/backups/psacc-$(date -u +%Y%m%dT%H%M%SZ).dump"
    step "Backing up the psacc database to $F"
    docker exec -e PGPASSWORD="$(env_get PSACC_OWNER_PASSWORD)" psacc-cp-postgres pg_dump -U psacc_owner -d psacc -Fc > "$F"
    (cd "$CP/backups" && sha256sum "$(basename "$F")" > "$(basename "$F").sha256")
    ls -la "$F"
    ;;
  restore)
    need_env
    SRC="${1:?usage: cp.sh restore <file.dump>}"
    [ -f "$SRC" ] || { echo "ERROR: $SRC not found" >&2; exit 1; }
    if [ -f "$SRC.sha256" ]; then (cd "$(dirname "$SRC")" && sha256sum -c "$(basename "$SRC").sha256"); fi
    step "Restoring $SRC (web and API are stopped meanwhile)"
    compose stop edge web api
    docker exec -i -e PGPASSWORD="$(env_get PSACC_OWNER_PASSWORD)" psacc-cp-postgres pg_restore -U psacc_owner -d psacc --clean --if-exists --no-owner < "$SRC"
    compose up -d
    ;;
  update)
    need_env
    step "Updating the checkout"
    git -C "$ROOT" pull --ff-only
    "$0" build
    step "Applying migrations and restarting"
    compose up -d
    compose ps
    ;;
  psql)
    need_env
    docker exec -it -e PGPASSWORD="$(env_get PSACC_OWNER_PASSWORD)" psacc-cp-postgres psql -U psacc_owner -d psacc
    ;;
  *)
    sed -n '2,17p' "$0"; exit 2 ;;
esac
