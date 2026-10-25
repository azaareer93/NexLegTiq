# Restore documents (D-141)

Documents live in the documents bucket under `{officeId}/{fileId}/{documentId}/{uuid}.{ext}` (D-035); the database row
(`document_versions.storage_key`) names each object. Two sources, in order:

1. **Versioning on the documents bucket** (where the provider supports it): restore the previous version of the deleted
   or overwritten objects from the provider's console or API. Nothing is lost.
2. **The weekly off-provider copy** under `documents/` in the backup bucket (`rclone sync`): objects as of the last Sunday
   run; what a run removed or replaced is kept 90 days under `documents-deleted/<run>/`, with the same keys below it.

## Restore some objects (one office, one file, a deleted object)
```bash
docker build --tag nexlegtiq-backup infra/backup
# backup.env: the RCLONE_CONFIG_BACKUP_*, RCLONE_CONFIG_DOCUMENTS_*, BACKUP_BUCKET and DOCUMENTS_BUCKET lines
docker run --rm --env-file backup.env nexlegtiq-backup -c \
  'rclone copy --checksum "backup:$BACKUP_BUCKET/documents/<officeId>/" "documents:$DOCUMENTS_BUCKET/<officeId>/"'
```
`copy` only adds missing or changed objects; it never deletes what is in the documents bucket.

## Restore everything (lost bucket or provider)
1. Create the new documents bucket (private, SSE as D-085 requires for AWS, versioning on).
2. Copy the whole `documents/` prefix back with the command above without an office prefix.
3. Point `S3_*` at the new bucket and restart the API and worker.
4. Check: `GET /health/ready` (storage check), then download a few documents in the office app.

## Afterwards
- Database rows whose object is missing (uploaded after the last weekly copy and lost with the bucket) download as
  STO-002: list them by comparing `document_versions.storage_key` with the bucket and tell the offices which uploads to
  repeat.
- Record what was lost and why in the post-mortem.
