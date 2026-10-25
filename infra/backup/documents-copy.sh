#!/bin/bash
# Off-provider copy of the documents bucket (D-141), refreshed weekly. A sync, so documents deleted on purpose (the
# retention purge, an erasure request) also leave the copy — but never at once: what the sync removes or overwrites is
# moved to documents-deleted/<run>/, which the bucket's lifecycle expires after 90 days, and a run that would remove more
# than DOCUMENTS_MAX_DELETE objects (default 500: an emptied or wrong source bucket) stops without deleting anything more.
# Objects are copied as they are (encrypted at rest by each provider, D-056); keys keep the {officeId}/ prefix.
#
# Environment: the rclone remotes `documents` (RCLONE_CONFIG_DOCUMENTS_*) and `backup` (RCLONE_CONFIG_BACKUP_*),
# DOCUMENTS_BUCKET, BACKUP_BUCKET, optional DOCUMENTS_MAX_DELETE.
set -euo pipefail

: "${DOCUMENTS_BUCKET:?}" "${BACKUP_BUCKET:?}"
run=$(date -u +%Y%m%dT%H%M%SZ)
started=$(date +%s)
rclone sync --checksum --stats 0 \
  --max-delete "${DOCUMENTS_MAX_DELETE:-500}" \
  --backup-dir "backup:$BACKUP_BUCKET/documents-deleted/$run" \
  "documents:$DOCUMENTS_BUCKET" "backup:$BACKUP_BUCKET/documents"
echo "Documents copied in $(($(date +%s) - started)) s"
