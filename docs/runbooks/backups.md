# Backups — setup, schedule and what they cover (D-141)

Targets (ops-security.md): RPO ≤ 15 min with provider point-in-time recovery, RTO 4 h. What exists:

| Layer | What | Kept | Where | Status |
|---|---|---|---|---|
| Database PITR | the managed Postgres provider's point-in-time recovery | ≥ 7 days | primary provider | **owner: enable when the provider is chosen** (D-103) |
| Database snapshots | the provider's daily snapshots | 30 days | primary provider | **owner: enable** |
| Database dumps | `pg_dump -Fc`, age-encrypted, weekly (Sunday 02:00 UTC) | weekly/ 90 days, monthly/ 365 days | a **second provider's** bucket | repo: `.github/workflows/backup.yml` |
| Restore test | newest dump restored into a scratch DB and checked | every run | GitHub Actions | repo: same workflow |
| Documents | versioning + lifecycle on the documents bucket | per provider | primary provider | **owner: enable where supported** |
| Documents copy | weekly `rclone copy` (never deletes) to the second provider | until lifecycle | second provider | repo: same workflow |

**Honest RPO today:** without provider PITR, a database loss can lose up to **7 days** (the last weekly dump); with PITR
enabled, ≤ 15 min. Documents: up to 7 days for objects lost on the primary without versioning. **RTO:** a restore of the
current data takes seconds (drill below); provisioning a new database and pointing the app at it is the bulk of the 4 h.

## First setup (once, by the owner)

1. **Keys.** Create two age key pairs (`age-keygen`): an **offline** one (secret key printed and stored offline, e.g. in a
   safe or a password manager the CI cannot reach — it is the one you restore with in a disaster) and a **CI** one (its
   secret key becomes `BACKUP_AGE_IDENTITY`, used only by the restore test). Dumps are encrypted to both public keys.
2. **Backup bucket** at a provider other than the documents bucket's (e.g. documents on R2, backups on Backblaze B2 or
   another region of S3), private, with lifecycle rules: `weekly/` expire after 90 days, `monthly/` after 365 days,
   `documents/` noncurrent versions after 90 days. An access key limited to this bucket with put, get, list and delete:
   delete only removes the partial object of a failed dump (otherwise it would be the "newest" and fail the next restore
   test); lifecycle rules do every other deletion.
3. **Read access for the copy:** a read-only key on the documents bucket.
4. **GitHub Environment `backup`** (Settings → Environments), restricted to the `develop`/`main` branches, with secrets:
   - `BACKUP_ENV` — an env file, one `VAR=value` per line:
     ```
     DATABASE_URL=postgresql://nexlegtiq_migrator:…@…/nexlegtiq?sslmode=verify-full
     AGE_RECIPIENTS=age1offline… age1ci…
     BACKUP_BUCKET=nexlegtiq-backups
     DOCUMENTS_BUCKET=nexlegtiq-documents
     RCLONE_CONFIG_BACKUP_TYPE=s3
     RCLONE_CONFIG_BACKUP_PROVIDER=Other            # or AWS, Cloudflare, Backblaze …
     RCLONE_CONFIG_BACKUP_ENDPOINT=https://…
     RCLONE_CONFIG_BACKUP_ACCESS_KEY_ID=…
     RCLONE_CONFIG_BACKUP_SECRET_ACCESS_KEY=…
     RCLONE_CONFIG_BACKUP_REGION=…
     RCLONE_CONFIG_DOCUMENTS_TYPE=s3
     RCLONE_CONFIG_DOCUMENTS_PROVIDER=…
     RCLONE_CONFIG_DOCUMENTS_ENDPOINT=https://…
     RCLONE_CONFIG_DOCUMENTS_ACCESS_KEY_ID=…
     RCLONE_CONFIG_DOCUMENTS_SECRET_ACCESS_KEY=…
     RCLONE_CONFIG_DOCUMENTS_REGION=…
     ```
     The migrator role is used because it can read every table (the read-only role cannot read tokens, D-079).
   - `BACKUP_AGE_IDENTITY` — the **CI** secret key (`AGE-SECRET-KEY-1…`).
   - `SLACK_WEBHOOK_URL` — optional; without it GitHub emails failed scheduled runs.
5. **Turn it on:** repository variable `BACKUP_ENABLED=true`, then run the workflow once by hand (Actions → Backup → Run
   workflow) and check the restore-test summary.
6. **Provider settings:** enable PITR (≥ 7 days) and daily snapshots (30 days) on the managed Postgres, and versioning on
   the documents bucket where the provider supports it. Update the table above with the real values.

## Drills

- **Local** (any time): `pnpm dev:up`, then `bash scripts/backup-drill.sh` — the same scripts against the dev stack, with a
  throwaway key.
- **Production restore drill:** once after setup, then quarterly: follow [restore-db.md](restore-db.md) into a scratch
  database, time it, and record the result below.

| Date | Where | Dump size | Restore + checks | Notes |
|---|---|---|---|---|
| 2026-10-25 | local dev stack (MVP-113) | 206 KB | 1 s + 0 s | first drill; 22 migrations, 44 offices; wrong key correctly refused |
