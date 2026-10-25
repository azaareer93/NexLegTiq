#!/bin/bash
# Off-provider copy of the documents bucket (D-141): objects new or changed since the last run are copied to the backup
# provider. `copy`, never `sync`: a document deleted (or a bucket emptied) on the primary is never deleted from the copy.
# Objects are stored as they are (already encrypted at rest by each provider, D-056); keys keep the {officeId}/ prefix.
#
# Environment: the rclone remotes `documents` (RCLONE_CONFIG_DOCUMENTS_*) and `backup` (RCLONE_CONFIG_BACKUP_*),
# DOCUMENTS_BUCKET, BACKUP_BUCKET.
set -euo pipefail

: "${DOCUMENTS_BUCKET:?}" "${BACKUP_BUCKET:?}"
started=$(date +%s)
rclone copy --checksum --stats-one-line --stats 0 \
  "documents:$DOCUMENTS_BUCKET" "backup:$BACKUP_BUCKET/documents"
echo "Documents copied in $(($(date +%s) - started)) s"
