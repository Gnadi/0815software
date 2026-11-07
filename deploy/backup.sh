#!/bin/sh
# Nightly backups for ONE stack — the line that goes into the host's crontab:
#
#   0 2 * * *  /opt/platform/deploy/backup.sh /opt/customers/xy >> /opt/customers/xy/backup.log 2>&1
#
# Without an argument it backs up the reference stack in this directory.
#
# Everything happens in backup.mjs beside this file: every running container
# that can back itself up snapshots its database (the containers are asked,
# never listed — a hardcoded list is how PS-11 and all modules once went
# unbacked-up), the snapshots and the stack's .env become one encrypted
# archive, and that archive goes to every target in the stack's backup.env —
# a NAS, an SFTP server, an S3 bucket — with retention applied there.
# Configure it with:  node <this dir>/backup.mjs setup <stack dir>
#
# Exits non-zero when anything was not backed up or did not reach a target.
set -eu
exec node "$(dirname "$0")/backup.mjs" run "${1:-$(dirname "$0")}"
