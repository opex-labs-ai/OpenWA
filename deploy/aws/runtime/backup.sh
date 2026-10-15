#!/bin/bash
#
# Logical backup wrapper.
#
# This is the SECONDARY backup. The primary one is the daily encrypted EBS snapshot taken by the
# Data Lifecycle Manager policy in the CDK stack, which captures the whole volume without any help
# from the instance. This script exists for the cases a block snapshot cannot serve: inspecting
# state, moving an install to another volume, or restoring a single piece.
#
# It does not reimplement anything. The repository already ships scripts/backup.sh, which is the
# authority on what state is load-bearing, and the Dockerfile copies it into the image at
# /app/scripts/backup.sh. This wrapper just calls it with the right data directory and guards.
#
# WARNING: the archive contains .api-key in PLAINTEXT, plus WhatsApp authentication state. Treat an
# archive exactly as you would the credentials themselves. Never attach one to a CI artifact, an
# issue, or unencrypted storage.
set -euo pipefail

APP_DIR="$(cat /etc/openwa-app-dir)"
DATA_DIR="$(cat /etc/openwa-data-dir)"
RETAIN="${OPENWA_BACKUP_KEEP:-7}"

log() { printf '[openwa-backup] %s %s\n' "$(date -Is)" "$*"; }
die() {
  log "FATAL $*"
  exit 1
}

mountpoint -q "$DATA_DIR" ||
  die "${DATA_DIR} is not a mount point; there is nothing worth backing up here"

docker inspect --format '{{.State.Running}}' openwa 2>/dev/null | grep -qx true ||
  die "the openwa container is not running, so the in-image backup script cannot be invoked. Take an EBS snapshot instead, or start the container first."

# Written inside the data volume so the archive inherits the volume's encryption. Keeping it here
# does mean snapshots include it, which is the trade for not needing a second encrypted location.
BACKUP_SUBDIR=backups
install -d -o 997 -g 997 -m 0700 "${DATA_DIR}/${BACKUP_SUBDIR}"

log "invoking the application's own backup script inside the container"
# -T: no TTY, this runs unattended from a timer or an SSM command.
# --user 997:997: the uid the application runs as, so the archive is not root-owned.
docker compose --file "${APP_DIR}/compose.yaml" exec -T --user 997:997 \
  --env OPENWA_DATA_DIR=/app/data \
  --env "BACKUP_DIR=/app/data/${BACKUP_SUBDIR}" \
  openwa bash /app/scripts/backup.sh

chmod 0700 "${DATA_DIR}/${BACKUP_SUBDIR}"
find "${DATA_DIR}/${BACKUP_SUBDIR}" -maxdepth 1 -type f -name '*.tar.gz' -exec chmod 0600 {} +

# Prune oldest first, keeping the most recent RETAIN archives. Only ever removes files this script's
# own naming produced; it never touches session data.
mapfile -t archives < <(find "${DATA_DIR}/${BACKUP_SUBDIR}" -maxdepth 1 -type f -name '*.tar.gz' -printf '%T@ %p\n' |
  sort -rn | cut -d' ' -f2-)
if [ "${#archives[@]}" -gt "$RETAIN" ]; then
  for stale in "${archives[@]:$RETAIN}"; do
    log "pruning ${stale}"
    rm -f -- "$stale"
  done
fi

log "backup complete; ${#archives[@]} archive(s) present, keeping ${RETAIN}"
log 'REMINDER the archive holds the plaintext bootstrap API key and WhatsApp authentication state.'
