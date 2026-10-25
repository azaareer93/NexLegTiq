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
1. Create an empty PostgreSQL 17 database with the extensions available (`vector`, `pg_trgm`, `unaccent`, `citext`;
   managed providers: run `docs/runbooks/db-roles.sql` as the admin first).
2. On a machine with Docker and this repository:
   ```bash
   docker build --tag nexlegtiq-backup infra/backup
   # restore.env: the RCLONE_CONFIG_BACKUP_* lines and BACKUP_BUCKET from the BACKUP_ENV secret (docs/runbooks/backups.md)
   docker run --rm --env-file restore.env \
     -e AGE_IDENTITY="$(cat offline-age-key.txt)" \
     -e SCRATCH_DATABASE_URL='postgresql://…new database…?sslmode=require' \
     nexlegtiq-backup /opt/backup/restore-check.sh
   ```
   It restores the newest dump of `weekly/` and runs the checks (`infra/backup/verify.sql`). To restore an older one, list
   them with `rclone lsf backup:$BACKUP_BUCKET/weekly/` (or `monthly/`) in the same image and run, inside it:
   `rclone cat backup:$BACKUP_BUCKET/weekly/<name> | age -d -i <key> | pg_restore --no-owner --no-privileges -d "$URL"`.
3. Re-apply the roles and grants (`docs/runbooks/db-roles.sql`) — dumps carry no owners or privileges.

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
