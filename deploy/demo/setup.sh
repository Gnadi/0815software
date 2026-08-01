#!/usr/bin/env bash
# One-shot provisioning for the hosted demo on a fresh server. Host-agnostic:
# anything with a public IP, ports 80/443 open and a recent Debian or Ubuntu —
# netcup, Hetzner, a box under a desk. Installs Docker, clones the repo,
# generates secrets, and — once you have set DEMO_DOMAIN + ACME_EMAIL —
# brings the demo up and installs the nightly reset.
#
# Run as root on the new box:
#   curl -fsSL https://raw.githubusercontent.com/Gnadi/0815software/main/deploy/demo/setup.sh | bash
#
# Re-run it any time to update the repo and restart the stack.
set -euo pipefail

REPO_URL="https://github.com/Gnadi/0815software"
REPO_DIR="/opt/0815software"
DEMO_DIR="$REPO_DIR/deploy/demo"

echo "==> Installing Docker (if needed)…"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
if ! command -v git >/dev/null 2>&1; then
  apt-get update -qq && apt-get install -y -qq git
fi

# The convenience script tracks distributions a little behind their release, so
# on a very new Debian it can install the engine and skip the compose plugin.
# Say so plainly instead of failing later inside `docker compose`.
if ! docker compose version >/dev/null 2>&1; then
  echo "!! Docker is installed but the compose plugin is missing."
  echo "   On Debian/Ubuntu:  apt-get install -y docker-compose-plugin"
  echo "   If that package is not found, your distribution release may be newer"
  echo "   than Docker's repository — see https://docs.docker.com/engine/install/"
  exit 1
fi

echo "==> Cloning / updating the repository…"
if [ ! -d "$REPO_DIR/.git" ]; then
  git clone --depth 1 "$REPO_URL" "$REPO_DIR"
else
  git -C "$REPO_DIR" pull --ff-only
fi

cd "$DEMO_DIR"

if [ ! -f .env ]; then
  echo "==> Creating .env with freshly generated secrets…"
  cp .env.example .env
  for KEY in SERVICE_TOKEN SESSION_SECRET ADMIN_PASSWORD WEBHOOK_SECRET INTAKE_SECRET; do
    sed -i "s|^${KEY}=.*|${KEY}=$(openssl rand -hex 32)|" .env
  done
  echo
  echo "  ┌────────────────────────────────────────────────────────────────┐"
  echo "  │  Almost there. Edit two values in $DEMO_DIR/.env :"
  echo "  │    DEMO_DOMAIN=demo.yourdomain.com"
  echo "  │    ACME_EMAIL=ops@yourdomain.com"
  echo "  │  Point DNS (A records) for demo. and *.demo. at this server,"
  echo "  │  then run this script again — it will bring the demo up."
  echo "  └────────────────────────────────────────────────────────────────┘"
  exit 0
fi

# Guard: refuse to start until the domain has actually been set.
if grep -q "^DEMO_DOMAIN=demo.example.com" .env; then
  echo "!! Set DEMO_DOMAIN (and ACME_EMAIL) in $DEMO_DIR/.env first, then re-run."
  exit 1
fi

# Caddy issues certificates over HTTP-01, so both ports have to be reachable
# from the internet. A host firewall that blocks them is the usual reason the
# demo comes up and then serves nothing.
for PORT in 80 443; do
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
    ufw allow "$PORT"/tcp >/dev/null 2>&1 || true
  fi
done

echo "==> Building and starting the stack (first build takes a few minutes)…"
docker compose up -d --build

echo "==> Installing the nightly reset cron…"
CRON_LINE="0 4 * * * cd $DEMO_DIR && ./reset.sh >> reset.log 2>&1"
( crontab -l 2>/dev/null | grep -v "deploy/demo && ./reset.sh" || true; echo "$CRON_LINE" ) | crontab -

DOMAIN="$(grep '^DEMO_DOMAIN=' .env | cut -d= -f2)"
echo
echo "==> Done. Once DNS has propagated and Caddy has issued certificates:"
echo "      https://${DOMAIN}"
echo "    Apps: offers. invoicing. support. documents.${DOMAIN}"
