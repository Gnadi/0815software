#!/bin/sh
# Reset the shared demo to its freshly-seeded state. Demo databases live on
# tmpfs, so restarting the containers clears them and every app re-seeds on
# boot; the init step re-stages the invoice sequence + file bucket.
#
# Schedule from the host's cron, e.g. nightly at 04:00:
#   0 4 * * *  cd /opt/0815-demo/deploy/demo && ./reset.sh >> reset.log 2>&1
set -eu
cd "$(dirname "$0")"
docker compose restart
echo "[reset] demo reset $(date -u +%FT%TZ)"
