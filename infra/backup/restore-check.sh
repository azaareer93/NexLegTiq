#!/bin/bash
# Restore test (D-141): the newest weekly backup is decrypted and restored into an empty scratch database, then checked
# (verify.sql). Fails when the newest backup is older than BACKUP_MAX_AGE_DAYS (default 8), when the restore fails, or
# when a check fails. Prints the timings the runbook's RTO is based on.
#
# Environment: SCRATCH_DATABASE_URL (an empty database with the extensions available), AGE_IDENTITY (the age secret
# key), the rclone remote `backup` (RCLONE_CONFIG_BACKUP_*), BACKUP_BUCKET.
set -euo pipefail

: "${SCRATCH_DATABASE_URL:?}" "${AGE_IDENTITY:?}" "${BACKUP_BUCKET:?}"
identity=$(mktemp)
trap 'rm -f "$identity"' EXIT
printf '%s\n' "$AGE_IDENTITY" >"$identity"

latest=$(
  { rclone lsf --files-only "backup:$BACKUP_BUCKET/weekly/" | grep '^nexlegtiq-.*\.dump\.age$' || true; } |
    sort | tail -n 1
)
if [ -z "$latest" ]; then
  echo "No backup found under weekly/" >&2
  exit 1
fi
# nexlegtiq-20261025T020000Z.dump.age → 2026-10-25
day=$(echo "$latest" | sed -n 's/^nexlegtiq-\([0-9]\{4\}\)\([0-9]\{2\}\)\([0-9]\{2\}\)T.*/\1-\2-\3/p')
age_days=$((($(date -u +%s) - $(date -u -d "$day" +%s)) / 86400))
if [ "$age_days" -gt "${BACKUP_MAX_AGE_DAYS:-8}" ]; then
  echo "Newest backup $latest is $age_days days old" >&2
  exit 1
fi

started=$(date +%s)
rclone cat "backup:$BACKUP_BUCKET/weekly/$latest" |
  age --decrypt --identity "$identity" |
  pg_restore --no-owner --no-privileges --exit-on-error --dbname "$SCRATCH_DATABASE_URL"
restored=$(date +%s)
psql --no-psqlrc --set ON_ERROR_STOP=1 --quiet --dbname "$SCRATCH_DATABASE_URL" --file /opt/backup/verify.sql
echo "Restored $latest ($age_days days old) in $((restored - started)) s; checks in $(($(date +%s) - restored)) s"
