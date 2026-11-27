# Security, Compliance & Operations

> Source: Security doc, DPA, ToS/Privacy, Deployment Guide, Infra Cost, DR, Incident Response, Backup & Restore,
> Troubleshooting, Data Migration & Seeding. Resolutions: D-020, D-021, D-053…D-060.

## Security controls (MVP)
- Transport: TLS 1.2+ (Caddy auto-TLS), HSTS 1y, HTTPS redirect.
- AuthN/Z: see `auth-rbac.md`. MFA (TOTP) for platform admins, admin realm only from `ADMIN_ORIGINS` and, before launch,
  behind `ADMIN_IP_ALLOWLIST` (D-145). Idle timeout 30 min default.
- Input: Zod at every boundary; Prisma parameterized only; uploads MIME-sniffed + ClamAV + size limit.
- Output: React escaping, sanitize-html for rich text, CSP (helmet), download via short-lived presigned URLs (5 min) after
  access check + audit `DOWNLOAD`. The API's CSP is helmet's; the SPAs' CSP (Pages headers) must allow the document preview
  (D-143): `img-src 'self' blob:`, `worker-src 'self'`, the bucket in `connect-src`, plus the bucket's CORS rule for GET.
- Data at rest: managed PG with encrypted storage + encrypted backups; object storage SSE; app-level AES-256-GCM for
  non-searchable sensitive fields (D-056) with `ENCRYPTION_KEY` (32 bytes hex) + key version prefix for rotation.
  Identifiers that must be found by exact value also get a blind index (HMAC-SHA256 under a key derived from
  `ENCRYPTION_KEY` with HKDF; D-135): rotating the key means re-encrypting the fields **and** recomputing every index.
- Secrets: never in repo; `.env.example` only; GitHub Environments for CI/CD; boot-time Zod validation.
- Logging: Pino JSON with redaction; request id propagated to jobs; no PII in logs beyond ids.
- Containers: non-root, read-only FS, `cap_drop: ALL`, `no-new-privileges`, tmpfs `/tmp`, resource limits; Trivy scan in CI.
- DB roles: `nexlegtiq_migrator` (DDL), `nexlegtiq_app` (DML, no UPDATE/DELETE on audit_log; the retention purge is the
  SECURITY DEFINER `nlq_purge_audit_logs`, D-136), `nexlegtiq_readonly` (script: `docs/runbooks/db-roles.sql`).
- Dependency hygiene: Renovate weekly, `pnpm audit`, lockfile committed.

## Privacy & compliance (product obligations)
- Legal acceptance at signup (ToS/Privacy versions), cookie consent on marketing site (app uses strictly necessary only).
- Product analytics (D-215): first-party per-office event counts in our own DB (no vendor, no cookie); honours DNT/GPC
  and the office setting `enableProductAnalytics`. DNT/GPC applies to request-time events; background events (AI
  summaries) follow the office setting only. No retention purge yet (rows are counts, cascade-deleted with the office).
- Data subject rights: export user data; office export (JSON/CSV + documents zip, async) ; office deletion = 30-day read-only
  grace, then the per-tenant purge (`nlq_purge_office`, D-251): every office row and stored object goes, issued invoices
  (as issued) and the anonymized audit log stay `RETAINED_RECORDS_YEARS` (7, pending legal confirmation). No legal hold yet.
- Retention defaults: audit 365d (configurable up), time entries 3y, invoices 6y, closed cases 5y then flag for review
  (never auto-delete legal records without office confirmation), ingested email 90d (Phase 2). Targets: only the audit
  purge and office deletion (D-251) exist; the 3y/6y/5y periods are not implemented (`legal-facts.md` §4).
- Sub-processors, data region (EU, D-021), AI data handling and retention as the legal texts may state them:
  **`legal-facts.md`** (D-220) — Facts checked against the code, and what is still pending the owner. Google Vision
  receives **unredacted scan images** (D-142: never confidential documents, only offices that opt in) — the privacy
  policy and DPA must say so.
- Breach: notify affected offices & regulators ≤ 72h; incident log.

## Environments & deploy (D-020)
- Runtime config (backend): `NODE_ENV=production` is the default when unset (fail closed: Swagger off, no pretty logs).
  Containers set `HOST=0.0.0.0`, `METRICS_HOST=0.0.0.0` with port 9464 **not published** (internal network only), and
  `TRUST_PROXY_HOPS=1` behind Caddy/Traefik so `req.ip` (lockout D-053, audit ipAddress) is the client, not the proxy.
- `local` docker compose (`docker/compose.dev.yml`): postgres (pgvector pg17), redis, minio, mailpit, clamav.
- `staging` ← `develop` auto-deploy; `prod` ← tag `v*` on `main` with manual approval (GitHub Environment protection).
- Pipeline: CI (lint/typecheck/test/build/coverage/security) → build images (api, worker) → push GHCR → SSH deploy
  (`docker compose pull && up -d`) → `prisma migrate deploy` (migrator role) as a one-off job → smoke tests `/health/ready` → Sentry release.
  Staging is built (D-103): `apps/backend-api/Dockerfile`, `infra/staging/`, `.github/workflows/deploy-staging.yml`,
  runbook `docs/runbooks/deploy.md`. Production releases are built (D-225): `infra/production/` (Caddy → `api-a` +
  `api-b`, rolling restart), `.github/workflows/release.yml` (reuses the staging-tested images), runbook
  `docs/runbooks/release.md`.
- SPAs → Cloudflare Pages (preview per PR). Env: `VITE_API_URL`, `VITE_WS_URL`, `VITE_SENTRY_DSN`, feature flags; office app also `VITE_SUPPORT_EMAIL`, `VITE_SUPPORT_WHATSAPP` (Help Center contact, D-185).
- Migrations: expand/contract for zero downtime; backup before prod migrate (release.yml takes an encrypted dump with the D-141 tools before every migrating release — D-225); rollback = previous image without migrating, or restore + previous image when a migration broke expand/contract.

## Backups & DR (right-sized)
- Managed PG: daily snapshots (30d) + PITR (7d) → RPO ≤ 15 min target when PITR available (else up to 7 days, the weekly dump — D-141).
- Weekly encrypted `pg_dump -Fc` to a second provider/bucket (90d), monthly (365d). Object storage versioning on.
- Weekly automated restore test into a scratch DB (GitHub Action) with row-count verification.
- RTO target 4h. Runbooks in `docs/runbooks/` (DB restore, bad deploy rollback, Redis loss, credential leak, provider outage).
- Implementation (D-141): `infra/backup/` (pg_dump + age + rclone image), `.github/workflows/backup.yml` (weekly dump,
  documents copy, restore test; off until `BACKUP_ENABLED`), runbooks `backups.md`, `restore-db.md`, `restore-documents.md`;
  local drill `bash scripts/backup-drill.sh`. PITR, snapshots and bucket versioning are provider settings (owner).

## Monitoring & incidents
Sentry EU (errors, releases) and Better Stack EU (log sink, 1-min uptime on `/health/ready` + SPAs, status page, alert
rules over `/metrics` incl. queue depth + failed jobs, SSL expiry, disk), AI cost daily alert — D-230,
`docs/runbooks/incident.md` (alert table, setup checklist, templates). Severity: CRITICAL (0–15 min), HIGH (≤1h), MEDIUM (≤4h),
LOW (≤2d). Post-mortem within 24h for CRITICAL/HIGH. Public status page before paid launch.

## Support (product hooks)
In-app help link → Help Center (User Guide is currently **blank** in Notion, D-073), bug report template with app/browser/
requestId, WhatsApp support link for Palestine, Sun–Thu 9–18 local hours.
