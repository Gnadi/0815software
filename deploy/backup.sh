#!/bin/sh
# Nightly backups: snapshot every service's database onto its own volume
# (each image ships scripts/backup.mjs; BACKUP_DIR=/data/backups is baked in).
# Run from this directory via the host's cron, e.g.:
#   0 2 * * *  cd /opt/platform/deploy && ./backup.sh >> backup.log 2>&1
set -eu
cd "$(dirname "$0")"
for svc in ps01 ps02 ps03 ps04 ps05 ps06 ps07 ps08 ps09 ps10; do
  echo "[backup] $svc"
  docker compose exec -T "$svc" npm run backup
done
echo "[backup] done $(date -u +%FT%TZ)"
