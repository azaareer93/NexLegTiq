# Restore the database (D-141)

Use the **newest point in time that is safe**: provider PITR first (minutes of loss), the provider's daily snapshot next,
the weekly encrypted dump last (up to 7 days of loss). Never restore over the live database: restore into a new one,
check it, then switch the app over.

## 1. Stop the writers
Put the API and worker in maintenance (staging: `docker compose stop api worker` on the host) so nothing writes to the
damaged database meanwhile. Note the time — it is the end of the incident window for the post-mortem.

## 2a. From provider PITR or a snapshot (preferred)
Follow the provider's console to restore to a **new** instance at the chosen time. Then go to step 3.

## 2b. From the weekly encrypted dump
1. Create an empty PostgreSQL 17 database and run `docs/runbooks/db-roles.sql` in it as the admin (roles and the
   extensions `vector`, `pg_trgm`, `unaccent`, `citext`).
2. Find the dump and its SHA-256 in the "Backup" run summary of that Sunday in GitHub Actions — a record kept apart from
   the bucket, so a file planted there is refused.
3. On a machine with Docker and this repository, with the **offline** age key in a file:
   ```bash
   docker build --tag nexlegtiq-backup infra/backup
   # restore.env: the BACKUP_BUCKET and RCLONE_CONFIG_BACKUP_* lines (the BACKUP_BUCKET_ENV secret, docs/runbooks/backups.md)
   docker run --rm --env-file restore.env \
     -v "$PWD/offline-age-key.txt:/run/secrets/age:ro" -e AGE_IDENTITY_FILE=/run/secrets/age \
     -e BACKUP_NAME=weekly/nexlegtiq-<stamp>.dump.age -e BACKUP_SHA256=<hash from the run summary> \
     -e BACKUP_RESTORE_ROLE=nexlegtiq_migrator \
     -e SCRATCH_DATABASE_URL='postgresql://<admin>:…@…/nexlegtiq?sslmode=verify-full&sslrootcert=system' \
     nexlegtiq-backup /opt/backup/restore-check.sh
   ```
   - Connect as the **admin** with `BACKUP_RESTORE_ROLE=nexlegtiq_migrator`: the restored tables and the SECURITY DEFINER
     purge function then belong to the migrator, as `prisma migrate deploy` and D-136 require.
   - Without `BACKUP_NAME` it takes the newest `weekly/` dump, refused when older than `BACKUP_MAX_AGE_DAYS` (default 8 —
     raise it in a disaster). `monthly/…` names work too.
   - `BACKUP_VERBOSE=1` prints pg_restore's own errors and the row counts: on your machine only, never in CI (public log).
   - Shred the key file afterwards.
4. Re-run `docs/runbooks/db-roles.sql`: dumps carry no grants, so the app, read-only and backup roles get theirs back.
5. The app needs the **same `ENCRYPTION_KEY`** as before (D-108, D-135): encrypted national and tax ids, confidential notes
   and the blind indexes are unreadable with another key.

## 3. Check and switch
1. Run `prisma migrate status` with the migrator role against the restored database: every migration must be applied (if
   the dump predates a migration, run `prisma migrate deploy`).
2. Spot-check a few recent files and documents in the office app against the scratch database (staging first).
3. Point `DATABASE_URL` (app and migrator) at the restored database, start the API and worker, watch `/health/ready`.

## 4. Afterwards
- Documents uploaded after the restore point exist in object storage without a database row: list them
  (`{officeId}/{fileId}/{documentId}/…` keys whose document id is unknown) and decide with the office.
- Redis holds only queues and caches: reminders are recreated by the nightly reconciliation (D-117); stuck documents can
  be retried from the app.
- Record the timeline, RPO/RTO reached and what to improve in the post-mortem (ops-security.md).
