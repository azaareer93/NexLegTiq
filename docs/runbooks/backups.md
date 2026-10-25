# Backups — setup, schedule and what they cover (D-141)

Targets (ops-security.md): RPO ≤ 15 min with provider point-in-time recovery, RTO 4 h. What exists:

| Layer | What | Kept | Where | Status |
|---|---|---|---|---|
| Database PITR | the managed Postgres provider's point-in-time recovery | ≥ 7 days | primary provider | **owner: enable when the provider is chosen** (D-103) |
| Database snapshots | the provider's daily snapshots | 30 days | primary provider | **owner: enable** |
| Database dumps | `pg_dump -Fc`, age-encrypted, weekly (Sunday 02:00 UTC), SHA-256 in the run summary | weekly/ 90 days, monthly/ 365 days | a **second provider's** bucket | repo: `.github/workflows/backup.yml` |
| Restore test | newest dump restored into a scratch DB and checked | every run | GitHub Actions | repo: same workflow |
| Documents | versioning + lifecycle on the documents bucket | per provider | primary provider | **owner: enable where supported** |
| Documents copy | weekly `rclone sync` to the second provider; removed or replaced objects kept 90 days in `documents-deleted/` | see left | second provider | repo: same workflow |

**Honest RPO today:** without provider PITR, a database loss can lose up to **7 days** (the last weekly dump); with PITR
enabled, ≤ 15 min. Documents: up to 7 days for objects lost on the primary without versioning. **RTO:** restoring the
current data takes seconds (drill below); provisioning a new database and pointing the app at it is the bulk of the 4 h.

**The repository is public, and so are its Actions logs:** the scripts print object names, sizes, SHA-256 hashes and
timings only — never row data, counts, errors from `pg_restore`/`psql`, or credentials.

## First setup (once, by the owner)

1. **Keys.** Create two age key pairs (`age-keygen`): an **offline** one (secret key kept offline, e.g. printed in a safe or
   in a password manager the CI cannot reach — it is the one you restore with in a disaster) and a **CI** one (its secret
   key becomes `BACKUP_AGE_IDENTITY`, used only by the restore test). Dumps are encrypted to both public keys.
2. **Backup bucket** at a provider other than the documents bucket's, in a region that fits D-021 (data residency), and
   listed as a sub-processor in the privacy policy/DPA before launch — it holds every office's data (dumps encrypted by us,
   documents encrypted at rest by the provider). Private, **provider-side encryption on**, **versioning on and Object Lock
   (governance, 30 days) where the provider supports it**, and lifecycle rules: `weekly/` expire after 90 days, `monthly/`
   after 365 days, `documents-deleted/` after 90 days, noncurrent versions after 30 days.
   Access key limited to this bucket: put, get, list, delete object — **not** delete object version or bypass governance
   (a stolen key then cannot destroy history). Delete is used only to remove a failed dump's partial object and by
   `rclone sync` (which moves objects to `documents-deleted/` first).
3. **Read access for the copy:** a read-only key on the documents bucket.
4. **Database role:** run `docs/runbooks/db-roles.sql` (creates `nexlegtiq_backup`: SELECT on every table, read-only
   sessions, owns nothing) and set its password. The database must accept TLS connections from GitHub-hosted runners.
5. **GitHub Environment `backup`** (Settings → Environments): deployment branches **`main` only**, and secrets:
   - `BACKUP_ENV` — an env file, one `VAR=value` per line, **no quotes, no comments, LF line endings**:
     ```
     DATABASE_URL=postgresql://nexlegtiq_backup:…@…:5432/nexlegtiq?sslmode=verify-full&sslrootcert=system
     AGE_RECIPIENTS=age1offline… age1ci…
     BACKUP_BUCKET=nexlegtiq-backups
     DOCUMENTS_BUCKET=nexlegtiq-documents
     RCLONE_CONFIG_BACKUP_TYPE=s3
     RCLONE_CONFIG_BACKUP_PROVIDER=Other
     RCLONE_CONFIG_BACKUP_ENDPOINT=https://…
     RCLONE_CONFIG_BACKUP_ACCESS_KEY_ID=…
     RCLONE_CONFIG_BACKUP_SECRET_ACCESS_KEY=…
     RCLONE_CONFIG_BACKUP_REGION=…
     RCLONE_CONFIG_DOCUMENTS_TYPE=s3
     RCLONE_CONFIG_DOCUMENTS_PROVIDER=Other
     RCLONE_CONFIG_DOCUMENTS_ENDPOINT=https://…
     RCLONE_CONFIG_DOCUMENTS_ACCESS_KEY_ID=…
     RCLONE_CONFIG_DOCUMENTS_SECRET_ACCESS_KEY=…
     RCLONE_CONFIG_DOCUMENTS_REGION=…
     ```
     (`PROVIDER` may be `AWS`, `Cloudflare`, `Backblaze`… — rclone's S3 provider names.)
   - `BACKUP_BUCKET_ENV` — the same `BACKUP_BUCKET` and `RCLONE_CONFIG_BACKUP_*` lines only: all the restore test gets.
   - `BACKUP_AGE_IDENTITY` — the **CI** secret key (`AGE-SECRET-KEY-1…`).
   - `SLACK_WEBHOOK_URL` — optional; without it GitHub emails failed scheduled runs.
6. **Turn it on:** repository variable `BACKUP_ENABLED=true`, then run the workflow once by hand (Actions → Backup → Run
   workflow, branch `main`) and check the summary: the dump's name and SHA-256, and "Restored … checks passed".
7. **Provider settings:** enable PITR (≥ 7 days) and daily snapshots (30 days) on the managed Postgres, and versioning on
   the documents bucket where the provider supports it. Update the table above with the real values. Before a production
   migration, take a provider snapshot by hand (ops-security.md) until the release pipeline automates it.

## Drills

- **Local** (any time): `pnpm dev:up`, then `bash scripts/backup-drill.sh` — the same scripts against the dev stack, with a
  throwaway key (TLS checks lifted with `BACKUP_ALLOW_INSECURE=1`, which nothing else may set).
- **Production restore drill:** once after setup, then quarterly: follow [restore-db.md](restore-db.md) into a scratch
  database with the **offline** key, time it, and record the result below.

| Date | Where | Dump size | Restore + checks | Notes |
|---|---|---|---|---|
| 2026-10-25 | local dev stack (MVP-113) | 206 KB | 1 s + 0 s | first drill; 22 migrations, 44 offices; wrong key, wrong hash and missing TLS refused |
