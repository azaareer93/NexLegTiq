#!/bin/bash
# Encrypted logical backup of the database (D-141): `pg_dump -Fc`, encrypted with age to the public key(s) in
# AGE_RECIPIENTS, streamed to the backup bucket — nothing unencrypted ever touches a disk or the bucket. With
# BACKUP_MONTHLY=1 the same object is also copied under monthly/ (kept 365 days by the bucket's lifecycle; weekly/ 90).
#
# Environment: DATABASE_URL (a role that can read every table: the migrator), AGE_RECIPIENTS (age public keys, separated
# by spaces, commas or lines), the rclone remote `backup` from RCLONE_CONFIG_BACKUP_* (type s3, provider, endpoint, keys,
# region) and BACKUP_BUCKET.
set -euo pipefail

: "${DATABASE_URL:?}" "${AGE_RECIPIENTS:?}" "${BACKUP_BUCKET:?}"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
name="nexlegtiq-$stamp.dump.age"
target="backup:$BACKUP_BUCKET/weekly/$name"
recipients=$(mktemp)
trap 'rm -f "$recipients"' EXIT
# A secret is one line: spaces and commas separate keys as well as newlines.
printf '%s\n' "$AGE_RECIPIENTS" | tr -s ' ,' '\n' | grep -v '^$' >"$recipients"

started=$(date +%s)
if ! pg_dump --format=custom --no-owner --no-privileges "$DATABASE_URL" |
  age --encrypt --recipients-file "$recipients" |
  rclone rcat "$target"; then
  # A dump that failed mid-stream may have left a truncated object behind.
  rclone deletefile "$target" 2>/dev/null || true
  echo "Backup $name failed" >&2
  exit 1
fi
size=$(rclone size --json "$target" | sed -n 's/.*"bytes":\([0-9]*\).*/\1/p')
if [ "${BACKUP_MONTHLY:-0}" = 1 ]; then
  rclone copyto "$target" "backup:$BACKUP_BUCKET/monthly/$name"
fi
echo "Backup weekly/$name: $size bytes in $(($(date +%s) - started)) s"
