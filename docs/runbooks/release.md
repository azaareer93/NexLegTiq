# Release runbook — production (D-020, D-225)

A tag `vX.Y.Z` on `main` releases to production. Nothing is rebuilt: production runs the exact images staging ran.

```
git tag vX.Y.Z <main commit> && git push origin vX.Y.Z
  └─ release.yml
       resolve:  tag on main? → its tree == a develop commit marked `staging/deployed`? → images exist?
       deploy:   GitHub Environment `production` (required reviewer = the approval)
                 → encrypted pg_dump to the backup bucket (infra/backup, D-141)
                 → scp infra/production/{compose.yml,Caddyfile,deploy.sh}, render app.env + migrate.env from secrets
                 → deploy.sh: pull → migrate (migrator role) → api-a, then api-b, then worker (each waits healthy)
                   → Caddy reload → /health/ready on both API containers
                 → public smoke test: https://api.<domain>/health/ready, HSTS header, admin routes 404 from outside
       notes:    GitHub release with notes generated from the merged PR titles
```

**Releasing:** merge `develop` into `main` (a merge commit, or any merge whose tree equals a develop commit that staging
ran green), wait for CI on `main`, then tag the merge commit. If `main` holds anything `develop` does not (a hotfix
committed straight to `main`), the resolve job refuses the tag: land the fix on `develop`, let staging deploy it, merge again.

**Zero downtime:** Caddy balances `api-a` and `api-b` with an active health check (`/health`, every 5 s) and retries a
failed connection on the other one for 15 s. `deploy.sh` replaces one container at a time and waits for its health check
before the next; Nest closes the HTTP server on SIGTERM and finishes in-flight requests (60 s grace). A request that races
the switch on an idle keep-alive connection can still see one 502 when it is not a GET (Caddy retries only idempotent
requests mid-flight). The worker restarts last; a job still running after the 60 s grace is picked up again by BullMQ's
stalled-job recovery, so it may run twice — keep job handlers safe to repeat.

## First setup (once)

Same shape as staging ([deploy.md](deploy.md), "First setup") with production values:

1. **Managed services** — Postgres 17 with `vector`, `pg_trgm`, `unaccent`, `citext` and **PITR (≥ 7 days)**;
   `db-roles.sql` as the admin. Redis with TLS. A private bucket `nexlegtiq-documents` with **versioning** and the CORS
   rule of D-143 for the production office-app origin. All in the D-021 region, all on the sub-processor list.
2. **Host** — a VPS with ≥ 4 GB RAM (two API containers, worker, ClamAV ~1.5 GB), Docker Engine + compose plugin, ports
   80/443 only, a `deploy` user in the `docker` group with key login only, `sudo install -d -o deploy -m 700
   /opt/nexlegtiq/production`. DNS `api.<domain>` A/AAAA → the host, **not** proxied by a CDN (`TRUST_PROXY_HOPS=1`).
3. **Domains** — `app.`, `portal.` and `admin.` are Cloudflare Pages custom domains (one Pages project per SPA,
   production branch `main`, `VITE_API_URL=https://api.<domain>`); turn on "Always use HTTPS" and HSTS
   (max-age 1 year, ops-security.md) in Cloudflare; `api.` gets HSTS from the Caddyfile. **Admin panel:** a
   Cloudflare Access policy (or a WAF IP rule) on `admin.<domain>` with the same ranges as `PROD_ADMIN_ALLOWED_IPS`; the
   API refuses the admin routes from elsewhere twice over (Caddy 404 + `ADMIN_IP_ALLOWLIST` 403 — the release refuses a
   `PROD_APP_ENV` without it).
4. **Deploy key** — a new `ssh-keygen -t ed25519 -C deploy-production` key (never the staging one); host key from
   `ssh-keyscan -t ed25519 <host>`, checked against the provider console's fingerprint.
5. **GitHub → Settings → Environments → `production`:**
   - **Required reviewers:** you (this is the manual approval). **Deployment branches and tags:** selected → tag rule
     `v*` and branch `main` (the rollback runs from `main`). Leave "allow administrators to bypass" off.
   - secrets: `PROD_SSH_KEY`, `PROD_SSH_KNOWN_HOSTS`, `PROD_APP_ENV` (the filled-in `infra/production/app.env.example`),
     `PROD_MIGRATE_DATABASE_URL` (migrator role, TLS), `PROD_BACKUP_ENV` (the dump part of the `backup` environment's
     `BACKUP_ENV`, D-141: `DATABASE_URL`, `AGE_RECIPIENTS`, `BACKUP_BUCKET`, `RCLONE_CONFIG_BACKUP_*` — not the documents
     keys; a release refuses to migrate without it). The dump runs on a GitHub-hosted runner, so the managed database
     must accept TLS connections from outside the host (password + `verify-full`); if you restrict it to the host's IP,
     move the dump onto the host first. Values in `PROD_APP_ENV` are taken literally: no quotes, and no `$` (compose
     would expand it);
   - variables: `PROD_SSH_TARGET` (`deploy@<host>`), `PROD_API_DOMAIN` (`api.<domain>`), `PROD_ADMIN_ALLOWED_IPS`
     (CIDRs separated by spaces).
6. **Repository variable** `PROD_DEPLOY=true` switches the deploy job on. Until then a tag runs only the resolve job —
   a free dry run of the checks.
7. **Tag protection** — Settings → Rules → a tag ruleset on `v*`: only you may create, update or delete.
8. **Platform admin** — as deploy.md step 7, against the production database.

## Rollback

Actions → **Release** → *Run workflow* (on `main`) with `version` = the previous tag (`releases.log` on the host lists
`<version> <sha>` per release; also Releases). Same approval, same rolling restart, the **tag's own** infra files,
**no dump and no migration** (`SKIP_MIGRATE=1`), no release notes. **Approver:** roll back only to a release the
current schema still serves — normally the one just before; further back only if no migration since then contracted
anything. By hand on the host:
`SKIP_MIGRATE=1 API_DOMAIN=… ADMIN_ALLOWED_IPS='…' sh /opt/nexlegtiq/production/deploy.sh ghcr.io/<owner>/nexlegtiq <sha>`.

**Migrations — expand/contract (ops-security.md):** rolling back the image never undoes a migration, and during a rolling
restart old and new containers run side by side for a minute, so **every migration must be readable by the previous
release**:
- *expand* (release N): add columns/tables nullable or with defaults; the code writes both the old and new shape;
- *migrate data* in a job or a later release;
- *contract* (release N+1 or later, once N is the rollback target no more): drop or rename the old shape.
A release that breaks this rule (a rename, a drop, a NOT NULL without default on a used table) is labelled
`needs-human-review` and its rollback is a **restore** instead: [restore-db.md](restore-db.md) from the dump the release
took, or PITR to just before the migration time shown in the run.

## Drills (log them here)

| Date | What | Result |
| --- | --- | --- |
| — | Dry-run release to a prod-like host (tag → resolve → deploy → smoke) | waits for the host |
| — | Rollback drill: release vN, roll back to vN-1 with requests running (`hey -z 60s https://api.<domain>/health`) — expect 0 non-2xx | waits for the host |

## Monthly cost at beta (estimate, target ≤ ~$100)

Approximate list prices, EU region (D-021), to be re-checked when ordering; staging adds roughly one more VPS and the
small database/Redis tiers.

| Item | Example (D-020 shapes) | ~$/month |
| --- | --- | --- |
| Production VPS, 4 vCPU / 8 GB | Hetzner CX32 (Falkenstein/Helsinki) | 8–10 |
| Managed Postgres 17 + pgvector, PITR 7 days | DigitalOcean 1 GB (FRA1) / Neon Launch (Frankfurt) | 15–25 |
| Managed Redis, TLS | Upstash pay-as-you-go (Frankfurt) / DO Valkey | 0–15 |
| Object storage + backup bucket | Cloudflare R2 (EU jurisdiction), < 50 GB | 1–5 |
| SPAs + DNS + Access (≤ 50 users) | Cloudflare Pages / DNS / Zero Trust free | 0 |
| Email | SMTP provider free tier (≤ 3k/month) | 0–15 |
| Domain | `.com` / `.ps` | 1–3 |
| **Production total** | | **~25–75** |

AI and OCR usage are metered per office (D-130 quotas) and not included.
