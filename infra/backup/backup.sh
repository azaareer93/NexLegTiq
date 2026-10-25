#!/bin/bash
# Encrypted logical backup of the database (D-141): `pg_dump -Fc`, encrypted with age to the public key(s) in
# AGE_RECIPIENTS, streamed to the backup bucket — nothing unencrypted ever touches a disk or the bucket. With
# BACKUP_MONTHLY=1 the same object is also copied under monthly/ (kept 365 days by the bucket's lifecycle; weekly/ 90).
# Prints the object's name, size and SHA-256 — nothing else, as the Actions log of this public repository is public:
# pg_dump's own messages stay in the container. Keep the printed hash: a restore checks the dump against it.
#
# Environment: DATABASE_URL (the read-only nexlegtiq_backup role, sslmode=verify-full|verify-ca), AGE_RECIPIENTS (age
# public keys, separated by spaces, commas or lines), the rclone remote `backup` from RCLONE_CONFIG_BACKUP_* (type s3,
# provider, https endpoint, keys, region) and BACKUP_BUCKET. BACKUP_ALLOW_INSECURE=1 lifts the TLS checks (dev drill only).
set -euo pipefail

: "${DATABASE_URL:?}" "${AGE_RECIPIENTS:?}" "${BACKUP_BUCKET:?}"
if [ "${BACKUP_ALLOW_INSECURE:-0}" != 1 ]; then
  [[ "$DATABASE_URL" =~ sslmode=verify-(full|ca) ]] || {
    echo 'DATABASE_URL must use sslmode=verify-full or verify-ca' >&2
    exit 1
  }
  [[ "${RCLONE_CONFIG_BACKUP_ENDPOINT:-https://}" == https://* ]] || {
    echo 'The backup endpoint must be https://' >&2
    exit 1
  }
fi
stamp=$(date -u +%Y%m%dT%H%M%SZ)
name="nexlegtiq-$stamp.dump.age"
target="backup:$BACKUP_BUCKET/weekly/$name"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
# A secret is one line: spaces and commas separate keys as well as newlines.
printf '%s\n' "$AGE_RECIPIENTS" | tr -s ' ,' '\n' | grep -v '^$' >"$work/recipients"

started=$(date +%s)
if ! pg_dump --format=custom --no-owner --no-privileges "$DATABASE_URL" 2>"$work/pg_dump.log" |
  age --encrypt --recipients-file "$work/recipients" |
  tee >(sha256sum | cut -d' ' -f1 >"$work/sha256") |
  rclone rcat "$target"; then
  # A dump that failed mid-stream may have left a truncated object behind.
  rclone deletefile "$target" 2>/dev/null || true
  echo "Backup $name failed (pg_dump, age or upload); details stay out of the public log" >&2
  exit 1
fi
sleep 1 # the hash is written by the process substitution, which may finish just after the pipeline
size=$(rclone size --json "$target" | sed -n 's/.*"bytes":\([0-9]*\).*/\1/p')
if [ "${BACKUP_MONTHLY:-0}" = 1 ]; then
  rclone copyto "$target" "backup:$BACKUP_BUCKET/monthly/$name"
fi
echo "Backup weekly/$name: $size bytes in $(($(date +%s) - started)) s, sha256 $(cat "$work/sha256")"
