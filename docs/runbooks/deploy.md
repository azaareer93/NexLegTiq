# Deploy runbook — staging (D-020, D-103)

Every green CI run on `develop` builds two images, pushes them to GHCR and rolls them out on the staging host:

```
ci.yml (lint · typecheck · test · build · secret scan)
  └─ deploy-staging.yml
       images:  ghcr.io/<owner>/nexlegtiq/backend-api:<sha>          (API + worker, one image)
                ghcr.io/<owner>/nexlegtiq/backend-api-migrate:<sha>  (prisma migrate deploy + plan seed)
       deploy:  scp infra/staging/{compose.yml,Caddyfile,deploy.sh} → render app.env + migrate.env from secrets
                → deploy.sh: pull → migrate (migrator role) → up --wait → /health/ready smoke test
```

The host only needs Docker and SSH. Postgres 17 + pgvector, Redis and the bucket are managed services; the SPAs are on
Cloudflare Pages. Nothing in the repo names a VPS provider or region (D-021 is still open).

## First setup (once)

1. **Managed services** — Postgres 17 with `vector`, `pg_trgm`, `unaccent`, `citext`; run `docs/runbooks/db-roles.sql` as
   the admin and set passwords for `nexlegtiq_migrator` and `nexlegtiq_app`. A Redis with TLS. A private bucket
   (`nexlegtiq-documents-staging`) with an access key limited to it.
2. **Host** — a VPS with ≥ 4 GB RAM (ClamAV alone needs ~1.5 GB), Docker Engine + compose plugin, ports 80/443 open,
   everything else closed. Create a `deploy` user in the `docker` group, allow only key login, and
   `sudo install -d -o deploy -m 700 /opt/nexlegtiq/staging`. Point `STAGING_API_DOMAIN` (DNS A/AAAA, **not** proxied
   by a CDN: Caddy must see client IPs, `TRUST_PROXY_HOPS=1`) at it.
3. **Deploy key** — `ssh-keygen -t ed25519 -C deploy-staging -f deploy-staging` on your machine; the public key goes into
   `~deploy/.ssh/authorized_keys`, the private key into the secret below. Host key: `ssh-keyscan -t ed25519 <host>`,
   checked against the provider console's fingerprint.
4. **GitHub → Settings → Environments → `staging`** (restrict to the `develop` branch):
   - secrets: `STAGING_SSH_KEY` (private key), `STAGING_SSH_KNOWN_HOSTS` (the keyscan line), `STAGING_APP_ENV` (the
     filled-in `infra/staging/app.env.example`), `STAGING_MIGRATE_DATABASE_URL` (the migrator role's URL, TLS);
   - variables: `STAGING_SSH_TARGET` (`deploy@<host>`), `STAGING_API_DOMAIN` (`api.staging.<domain>`),
     `STAGING_ALLOWED_IPS` (CIDRs separated by spaces — the office, your home, testers; everyone else gets 403).
5. **Repository variable** `STAGING_DEPLOY=true` switches the deploy job on (images are built either way).
6. **SPAs** — Cloudflare Pages Git integration, one project per app (office-app first): build command
   `pnpm nx build office-app`, output `apps/office-app/dist`, production branch `develop`, env `VITE_API_URL=https://<STAGING_API_DOMAIN>`;
   Pages builds a preview per PR by itself. Put the Pages domains behind Cloudflare Access (email one-time PIN) so
   staging is not public, and list them in `CORS_ORIGINS`.
7. **Reference data** — the migrate job seeds the plans (create-only). Demo data is not seeded: `seed-demo` refuses
   `NODE_ENV=production` and its user has no usable password; sign up on staging instead.

## Normal deploy

Merge to `develop`. Watch Actions → CI → *Deploy staging*. The run fails (and the old containers keep running if
`up` never started) when the migration, the health checks or the `/health/ready` smoke test fail. On the host,
`/opt/nexlegtiq/staging/deployed-tag` holds the running SHA and `previous-tag` the one before.

## Rollback

Actions → **Deploy staging** → *Run workflow* on `develop` with `tag` = the previous SHA (`previous-tag` on the host, or
any green develop commit). No image is built; the old images are pulled and started. By hand on the host:
`API_DOMAIN=… STAGING_ALLOWED_IPS='…' sh /opt/nexlegtiq/staging/deploy.sh ghcr.io/<owner>/nexlegtiq <sha>`
(after `docker login ghcr.io` if the packages are private).

Migrations are forward-only: rolling back the image does **not** undo a migration. That is safe as long as migrations
follow expand/contract (ops-security.md) — an old image never meets a schema it cannot read. A migration that breaks
that rule needs a database restore (backups runbook) instead.

## Troubleshooting

- `docker compose logs -f api worker` in `/opt/nexlegtiq/staging`; the boot error names every invalid variable (never
  its value).
- `docker compose run --rm migrate` re-runs migrations + plan seed alone.
- The ClamAV container needs a few minutes on first start (signature download); `up --wait` allows 10 minutes.

## Not covered yet

Sentry releases (monitoring story), production (release pipeline story), backups and restore tests (backups story),
provisioning as code (Terraform for VPS/DNS/bucket — waits for the provider choice, D-103).
