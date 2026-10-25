#!/usr/bin/env bash
# Local restore drill (D-141) against the dev stack (`pnpm dev:up`): builds the backup image, makes a throwaway age key,
# backs up the dev database to a local RustFS bucket, restores it into a scratch database, runs the checks and prints the
# timings. Uses only the documented dev credentials (docker/compose.dev.yml); production runs the same scripts from
# .github/workflows/backup.yml. Usage: bash scripts/backup-drill.sh
set -euo pipefail

image=nexlegtiq-backup:drill
network=nexlegtiq_default
bucket=nexlegtiq-backups-local
scratch=nexlegtiq_restore_drill
dev_db=postgresql://nexlegtiq:nexlegtiq@postgres:5432

docker build --quiet --tag "$image" infra/backup >/dev/null

# The rclone remote `backup` points at the dev stack's RustFS.
rclone_env=(
  -e RCLONE_CONFIG_BACKUP_TYPE=s3
  -e RCLONE_CONFIG_BACKUP_PROVIDER=Other
  -e RCLONE_CONFIG_BACKUP_ENDPOINT=http://s3:9000
  -e RCLONE_CONFIG_BACKUP_ACCESS_KEY_ID=nexlegtiq
  -e RCLONE_CONFIG_BACKUP_SECRET_ACCESS_KEY=nexlegtiq-dev-only
  -e RCLONE_CONFIG_BACKUP_REGION=us-east-1
  -e BACKUP_BUCKET="$bucket"
)
run() { docker run --rm --network "$network" "${rclone_env[@]}" "$@"; }

key=$(run "$image" -c 'age-keygen 2>/dev/null')
identity=$(printf '%s\n' "$key" | grep '^AGE-SECRET-KEY-')
recipient=$(printf '%s\n' "$key" | sed -n 's/^# public key: //p')

run "$image" -c "rclone mkdir backup:$bucket"
# The dev stack has no TLS: the drill lifts the production TLS checks.
run -e DATABASE_URL="$dev_db/nexlegtiq" -e AGE_RECIPIENTS="$recipient" -e BACKUP_ALLOW_INSECURE=1 \
  "$image" /opt/backup/backup.sh

run "$image" -c "psql --no-psqlrc --quiet '$dev_db/postgres' \
  -c 'DROP DATABASE IF EXISTS $scratch' -c 'CREATE DATABASE $scratch'"
trap 'run "$image" -c "psql --no-psqlrc --quiet \"$dev_db/postgres\" -c \"DROP DATABASE IF EXISTS $scratch\"" >/dev/null' EXIT
run -e SCRATCH_DATABASE_URL="$dev_db/$scratch" -e AGE_IDENTITY="$identity" -e BACKUP_VERBOSE=1 \
  "$image" /opt/backup/restore-check.sh
