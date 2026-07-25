#!/usr/bin/env bash
# One-shot provisioning for a fresh Hetzner Cloud server (Ubuntu 24.04).
# Installs Docker, clones the repo, generates secrets, and — once you've set
# DEMO_DOMAIN + ACME_EMAIL — brings the hosted demo up.
#
# Run as root on the new box:
#   curl -fsSL https://raw.githubusercontent.com/Gnadi/0815software/main/deploy/demo/setup-hetzner.sh | bash
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
