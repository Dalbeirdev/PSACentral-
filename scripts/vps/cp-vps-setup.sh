#!/usr/bin/env bash
# PSA Control Center — one-time preparation of a dedicated Ubuntu VPS (22.04 / 24.04) for the
# containerized Control Plane with a public domain. Idempotent: safe to run again.
#
#   curl -fsSL https://raw.githubusercontent.com/Dalbeirdev/PSACentral-/main/scripts/vps/cp-vps-setup.sh | sudo bash
#   (or clone the repository and run: sudo scripts/vps/cp-vps-setup.sh)
#   Rehearsal on a workstation (no ufw, local registry): PSACC_SKIP_FIREWALL=1 PSACC_DIR=/opt/psacc-rehearsal ...
#
# What it does: installs Docker Engine + Compose, opens only 22/80/443 and the agent gateway port in
# ufw, clones (or updates) the repository into /opt/psacc, and writes infra/control-plane/.env with
# production settings and fresh random secrets (nothing is printed). It does not start anything —
# the remaining steps are printed at the end and described in docs/DEPLOY-VPS.md.
set -euo pipefail
REPO_URL="${PSACC_REPO_URL:-https://github.com/Dalbeirdev/PSACentral-.git}"
TARGET="${PSACC_DIR:-/opt/psacc}"
DOMAIN="${PSACC_DOMAIN:-techpio.tech}"
ADMIN_EMAIL="${PSACC_ADMIN_EMAIL:-}"
EDGE_REPO="${PSACC_EDGE_IMAGE_REPOSITORY:-ghcr.io/dalbeirdev/psa-edge}"
GATEWAY_PORT="${PSACC_GATEWAY_PORT:-8643}"
# Coexistence with another product on the same server (PioDesk owns 80/443): PSACC_COEXIST=1 keeps the
# Control Plane on its own ports (dashboard PSACC_HTTPS_PORT, gateway PSACC_GATEWAY_PORT) and validates
# certificates by DNS through the Hostinger API (HOSTINGER_API_TOKEN, asked for below, never printed).
COEXIST="${PSACC_COEXIST:-0}"
HTTPS_PORT="${PSACC_HTTPS_PORT:-8443}"
[ "$COEXIST" = 1 ] || HTTPS_PORT="${PSACC_HTTPS_PORT:-443}"

step() { printf '\n==> %s\n' "$1"; }
fail() { printf 'ERROR: %s\n' "$1" >&2; exit 1; }
[ "$(id -u)" = 0 ] || fail "run as root (sudo)."
. /etc/os-release 2>/dev/null || true
[ "${ID:-}" = ubuntu ] || echo "WARNING: tested on Ubuntu; continuing on ${PRETTY_NAME:-unknown OS}."

step "Docker Engine and Compose"
if ! command -v docker >/dev/null 2>&1; then
  apt-get update -q
  apt-get install -y -q ca-certificates curl gnupg git ufw
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-compose-plugin
else
  apt-get install -y -q git ufw >/dev/null 2>&1 || true
fi
if command -v systemctl >/dev/null 2>&1 && systemctl is-system-running >/dev/null 2>&1; then systemctl enable --now docker; fi
docker info >/dev/null 2>&1 || fail "Docker Engine is not running."
docker compose version

if [ "${PSACC_SKIP_FIREWALL:-0}" = 1 ]; then
  step "Firewall: skipped (PSACC_SKIP_FIREWALL=1 — rehearsal or an externally managed firewall)"
else
  step "Firewall: SSH, HTTP, HTTPS and the agent gateway ($GATEWAY_PORT) only"
  command -v ufw >/dev/null 2>&1 || apt-get install -y -q ufw
  if [ "$COEXIST" = 1 ]; then
    # Another product owns this server's firewall policy: only this product's two ports are added, and only
    # when ufw is already active; nothing is enabled, removed or changed otherwise.
    if ufw status 2>/dev/null | grep -q '^Status: active'; then
      ufw allow "$HTTPS_PORT/tcp" >/dev/null
      ufw allow "$GATEWAY_PORT/tcp" >/dev/null
      echo "  ufw active: allowed $HTTPS_PORT/tcp and $GATEWAY_PORT/tcp (nothing else touched)"
    else
      echo "  ufw not active: no firewall change (open $HTTPS_PORT/tcp and $GATEWAY_PORT/tcp in whatever manages this server's firewall)"
    fi
  else
  ufw allow OpenSSH >/dev/null
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw allow "$GATEWAY_PORT/tcp" >/dev/null
  ufw --force enable >/dev/null
  ufw status | sed 's/^/  /'
  fi
fi

step "Repository in $TARGET"
if [ -d "$TARGET/.git" ]; then
  git -C "$TARGET" pull --ff-only
else
  git clone --depth 1 "$REPO_URL" "$TARGET"
fi
chmod +x "$TARGET"/scripts/vps/*.sh

ENV_FILE="$TARGET/infra/control-plane/.env"
case "$EDGE_REPO" in *:*) fail "PSACC_EDGE_IMAGE_REPOSITORY must not contain a port ($EDGE_REPO): use a registry host such as ghcr.io/<owner>/psa-edge." ;; esac
PORT_SUFFIX=""; [ "$HTTPS_PORT" = 443 ] || PORT_SUFFIX=":$HTTPS_PORT"
case "$DOMAIN" in *[a-z]*) ORIGINS="https://$DOMAIN$PORT_SUFFIX,https://www.$DOMAIN$PORT_SUFFIX" ;; *) ORIGINS="https://$DOMAIN$PORT_SUFFIX" ;; esac  # an IP address has no www
HOSTINGER_TOKEN=""
if [ "$COEXIST" = 1 ] && [ ! -f "$ENV_FILE" ]; then
  echo "  Coexistence mode: dashboard on https://$DOMAIN$PORT_SUFFIX, agent gateway on $GATEWAY_PORT; certificates by DNS validation."
  while [ -z "$HOSTINGER_TOKEN" ]; do read -r -s -p "  Hostinger API token (panel -> Account -> API; input hidden): " HOSTINGER_TOKEN; echo; done
fi
step "Production environment file $ENV_FILE"
if [ -f "$ENV_FILE" ]; then
  echo "  exists — kept (delete it to regenerate; secrets are never printed)."
else
  while [ -z "$ADMIN_EMAIL" ]; do read -r -p "  Administrator e-mail (first sign-in and Let's Encrypt notices): " ADMIN_EMAIL; done
  VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$TARGET/apps/api/package.json" | head -n 1)"
  hex() { openssl rand -hex "$1"; }
  b64() { openssl rand -base64 "$1" | tr -d '\n'; }
  ADMIN_PASSWORD="Cp-$(hex 8)-$(hex 4)"
  umask 077
  cat > "$ENV_FILE" <<EOF
# Generated by scripts/vps/cp-vps-setup.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ) — production. Do not commit, do not share.
VERSION=${VERSION:-0.1.0}
APP_ENV=production
LOG_LEVEL=info
OPENAPI_ENABLED=false
AUTH_MFA_REQUIRED=true
PSACC_DOMAIN=$DOMAIN
LETSENCRYPT_EMAIL=$ADMIN_EMAIL
# Coexistence (another product owns 80/443 on this server): 1 keeps the edge on PSACC_HTTPS_PORT only and
# validates certificates by DNS through the Hostinger API.
PSACC_COEXIST=$COEXIST
PSACC_HTTPS_PORT=$HTTPS_PORT
HOSTINGER_API_TOKEN=$HOSTINGER_TOKEN
WEB_PORT=3410
API_PORT=4410
APP_ALLOWED_ORIGINS=$ORIGINS
AGENT_GATEWAY_BIND=0.0.0.0
AGENT_GATEWAY_PORT=$GATEWAY_PORT
AGENT_GATEWAY_URL=https://$DOMAIN:$GATEWAY_PORT
EDGE_HEARTBEAT_SECONDS=60
EDGE_IMAGE_REPOSITORY=$EDGE_REPO
EDGE_IMAGE_VERSION=${VERSION:-0.1.0}
# Filled by 'scripts/vps/cp.sh push-edge' after the edge image is pushed; production refuses to start without it.
EDGE_IMAGE_DIGEST=
POSTGRES_PASSWORD=$(hex 24)
PSACC_OWNER_PASSWORD=$(hex 24)
PSACC_APP_PASSWORD=$(hex 24)
CSRF_SECRET=$(b64 32)
DATA_ENCRYPTION_KEY=$(b64 32)
LICENSE_SIGNING_KEY=$(b64 32)
BOOTSTRAP_ORG_NAME=TechPio
BOOTSTRAP_ORG_SLUG=techpio
BOOTSTRAP_ADMIN_EMAIL=$ADMIN_EMAIL
BOOTSTRAP_ADMIN_NAME=Platform Administrator
BOOTSTRAP_ADMIN_PASSWORD=$ADMIN_PASSWORD
EOF
  echo "  written (mode 600). The first administrator password is in BOOTSTRAP_ADMIN_PASSWORD; read it with:"
  echo "    sudo grep BOOTSTRAP_ADMIN_PASSWORD $ENV_FILE"
fi

cat <<EOF

Prepared. Remaining steps (details in docs/DEPLOY-VPS.md):
  1. Point the DNS A record of $DOMAIN (and www) at this server's address, then wait until it resolves (skip for an IP-address rehearsal).
  2. cd $TARGET && scripts/vps/cp.sh build        # API, web and edge images (several minutes)
  3. docker login <registry> && scripts/vps/cp.sh push-edge   # client packages pull $EDGE_REPO; records the digest
  4. scripts/vps/cp.sh cert                        # Let's Encrypt certificate for $DOMAIN$( [ "$COEXIST" = 1 ] && printf ' (DNS validation; run scripts/vps/cp.sh dns-test first)' )
  5. scripts/vps/cp.sh up && scripts/vps/cp.sh bootstrap && scripts/vps/cp.sh status
  6. Sign in at https://$DOMAIN$PORT_SUFFIX, enrol MFA (required in production), change the password.
EOF
