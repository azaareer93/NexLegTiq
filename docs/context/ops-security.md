# Security, Compliance & Operations

> Source: Security doc, DPA, ToS/Privacy, Deployment Guide, Infra Cost, DR, Incident Response, Backup & Restore,
> Troubleshooting, Data Migration & Seeding. Resolutions: D-020, D-021, D-053…D-060.

## Security controls (MVP)
- Transport: TLS 1.2+ (Caddy auto-TLS), HSTS 1y, HTTPS redirect.
- AuthN/Z: see `auth-rbac.md`. MFA for platform admins. Idle timeout 30 min default.
- Input: Zod at every boundary; Prisma parameterized only; uploads MIME-sniffed + ClamAV + size limit.
- Output: React escaping, sanitize-html for rich text, CSP (helmet), download via short-lived presigned URLs (5 min) after
  access check + audit `DOWNLOAD`.
- Data at rest: managed PG with encrypted storage + encrypted backups; object storage SSE; app-level AES-256-GCM for
  non-searchable sensitive fields (D-056) with `ENCRYPTION_KEY` (32 bytes hex) + key version prefix for rotation.
- Secrets: never in repo; `.env.example` only; GitHub Environments for CI/CD; boot-time Zod validation.
- Logging: Pino JSON with redaction; request id propagated to jobs; no PII in logs beyond ids.
- Containers: non-root, read-only FS, `cap_drop: ALL`, `no-new-privileges`, tmpfs `/tmp`, resource limits; Trivy scan in CI.
- DB roles: `nexlegtiq_migrator` (DDL), `nexlegtiq_app` (DML, no DELETE on audit_log), `nexlegtiq_readonly` (script: `docs/runbooks/db-roles.sql`).
- Dependency hygiene: Renovate weekly, `pnpm audit`, lockfile committed.

## Privacy & compliance (product obligations)
- Legal acceptance at signup (ToS/Privacy versions), cookie consent on marketing site (app uses strictly necessary only).
- Data subject rights: export user data; office export (JSON/CSV + documents zip, async) ; account deletion = 30-day grace then hard
  delete of documents + anonymization of audit actors; block if legal hold.
- Retention defaults: audit 365d (configurable up), time entries 3y, invoices 6y, closed cases 5y then flag for review
  (never auto-delete legal records without office confirmation), ingested email 90d (Phase 2).
- Sub-processors (update DPA/FAQ to match actual): hosting VPS provider, managed Postgres, managed Redis, object storage,
  OpenAI, Google Cloud (Vision, Gemini), Resend, Sentry. Data region per D-021.
- Breach: notify affected offices & regulators ≤ 72h; incident log.

## Environments & deploy (D-020)
- Runtime config (backend): `NODE_ENV=production` is the default when unset (fail closed: Swagger off, no pretty logs).
  Containers set `HOST=0.0.0.0`, `METRICS_HOST=0.0.0.0` with port 9464 **not published** (internal network only), and
  `TRUST_PROXY_HOPS=1` behind Caddy/Traefik so `req.ip` (lockout D-053, audit ipAddress) is the client, not the proxy.
- `local` docker compose (`docker/compose.dev.yml`): postgres (pgvector pg17), redis, minio, mailpit, clamav.
- `staging` ← `develop` auto-deploy; `prod` ← tag `v*` on `main` with manual approval (GitHub Environment protection).
- Pipeline: CI (lint/typecheck/test/build/coverage/security) → build images (api, worker) → push GHCR → SSH deploy
  (`docker compose pull && up -d`) → `prisma migrate deploy` (migrator role) as a one-off job → smoke tests `/health/ready` → Sentry release.
- SPAs → Cloudflare Pages (preview per PR). Env: `VITE_API_URL`, `VITE_WS_URL`, `VITE_SENTRY_DSN`, feature flags.
- Migrations: expand/contract for zero downtime; backup before prod migrate; rollback = restore + previous image.

## Backups & DR (right-sized)
- Managed PG: daily snapshots (30d) + PITR (7d) → RPO ≤ 15 min target when PITR available (else 24h, documented).
- Weekly encrypted `pg_dump -Fc` to a second provider/bucket (90d), monthly (365d). Object storage versioning on.
- Weekly automated restore test into a scratch DB (GitHub Action) with row-count verification.
- RTO target 4h. Runbooks in `docs/runbooks/` (DB restore, bad deploy rollback, Redis loss, credential leak, provider outage).

## Monitoring & incidents
Sentry (errors, releases, perf traces sampled), UptimeRobot (1 min) on `/health/ready` + SPAs, logs to a hosted log sink,
queue depth + failed jobs alerts, AI cost daily alert, SSL expiry. Severity: CRITICAL (0–15 min), HIGH (≤1h), MEDIUM (≤4h),
LOW (≤2d). Post-mortem within 24h for CRITICAL/HIGH. Public status page before paid launch.

## Support (product hooks)
In-app help link → Help Center (User Guide is currently **blank** in Notion, D-073), bug report template with app/browser/
requestId, WhatsApp support link for Palestine, Sun–Thu 9–18 local hours.
