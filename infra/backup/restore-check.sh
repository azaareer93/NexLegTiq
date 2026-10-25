#!/bin/bash
# Restore test and disaster restore (D-141): a dump of the backup bucket is checked against an expected SHA-256 when one
# is given, decrypted and restored into an empty database, then checked (verify.sql). By default the newest weekly dump,
# refused when dated in the future or older than BACKUP_MAX_AGE_DAYS (default 8; raise it for a disaster restore).
# Output is only pass/fail, the dump's name and hash, and timings: pg_restore and psql messages can quote table rows, and
# the Actions log of this public repository is public — they stay in the container.
#
# Environment: SCRATCH_DATABASE_URL (an empty database with the extensions available); the age secret key in
# AGE_IDENTITY_FILE (a mounted file: the offline key) or AGE_IDENTITY (the CI key); the rclone remote `backup`
# (RCLONE_CONFIG_BACKUP_*) and BACKUP_BUCKET. Optional: BACKUP_NAME (a path under the bucket, e.g. monthly/nexlegtiq-….age),
# BACKUP_SHA256 (refuse a dump with another hash), BACKUP_RESTORE_ROLE (production: nexlegtiq_migrator, so the tables and
# the SECURITY DEFINER purge function belong to it — connect as the admin, after db-roles.sql), BACKUP_VERBOSE=1 (print the
# restore's own errors and the row counts: never in CI).
set -euo pipefail

: "${SCRATCH_DATABASE_URL:?}" "${BACKUP_BUCKET:?}"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
if [ -n "${AGE_IDENTITY_FILE:-}" ]; then
  identity=$AGE_IDENTITY_FILE
else
  : "${AGE_IDENTITY:?AGE_IDENTITY or AGE_IDENTITY_FILE}"
  identity="$work/identity"
  printf '%s\n' "$AGE_IDENTITY" >"$identity"
fi

if [ -n "${BACKUP_NAME:-}" ]; then
  path=$BACKUP_NAME
else
  latest=$(
    { rclone lsf --files-only "backup:$BACKUP_BUCKET/weekly/" | grep -E '^nexlegtiq-[0-9]{8}T[0-9]{6}Z\.dump\.age$' || true; } |
      sort | tail -n 1
  )
  if [ -z "$latest" ]; then
    echo "No backup found under weekly/" >&2
    exit 1
  fi
  path="weekly/$latest"
  # nexlegtiq-20261025T020000Z.dump.age → 2026-10-25
  day="${latest:10:4}-${latest:14:2}-${latest:16:2}"
  age_days=$((($(date -u +%s) - $(date -u -d "$day" +%s)) / 86400))
  # A dump dated in the future would always sort newest: refuse it rather than restore a planted file.
  if [ "$age_days" -lt 0 ] || [ "$age_days" -gt "${BACKUP_MAX_AGE_DAYS:-8}" ]; then
    echo "Newest backup $latest is dated $age_days days ago: refused" >&2
    exit 1
  fi
fi

started=$(date +%s)
rclone copyto "backup:$BACKUP_BUCKET/$path" "$work/dump.age"
sha256=$(sha256sum "$work/dump.age" | cut -d' ' -f1)
if [ -n "${BACKUP_SHA256:-}" ] && [ "$sha256" != "$BACKUP_SHA256" ]; then
  echo "$path has sha256 $sha256, expected $BACKUP_SHA256: refused" >&2
  exit 1
fi
if ! age --decrypt --identity "$identity" "$work/dump.age" 2>"$work/errors.log" |
  pg_restore --no-owner --no-privileges --no-comments --exit-on-error \
    ${BACKUP_RESTORE_ROLE:+--role="$BACKUP_RESTORE_ROLE"} \
    --dbname "$SCRATCH_DATABASE_URL" 2>>"$work/errors.log"; then
  echo "Restore of $path failed" >&2
  if [ "${BACKUP_VERBOSE:-0}" = 1 ]; then cat "$work/errors.log" >&2; fi
  exit 1
fi
restored=$(date +%s)
if ! psql --no-psqlrc --set ON_ERROR_STOP=1 --quiet --dbname "$SCRATCH_DATABASE_URL" \
  --file /opt/backup/verify.sql >"$work/checks.log" 2>&1; then
  echo "Checks of $path failed: $(grep -o 'restore check: [^"]*' "$work/checks.log" | head -n 1)" >&2
  if [ "${BACKUP_VERBOSE:-0}" = 1 ]; then cat "$work/checks.log" >&2; fi
  exit 1
fi
if [ "${BACKUP_VERBOSE:-0}" = 1 ]; then cat "$work/checks.log"; fi
echo "Restored $path (sha256 $sha256) in $((restored - started)) s; checks passed in $(($(date +%s) - restored)) s"
