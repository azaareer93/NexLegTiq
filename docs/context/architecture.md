# Architecture

> From: Technical Architecture, Backend Deep Dive, Flow Charts, Dev Guidelines, Performance, Deployment.
> Resolutions: `decisions.md` (D-010…D-021).

## Monorepo (Nx + pnpm, Node 22)
Tooling (MVP-28): Nx 23 with TS project references, pnpm 10 workspaces, **TypeScript 6.0** (TS 7 is not yet supported by
Nx/typescript-eslint). Shared packages are non-buildable TS source packages (`exports` → `src/index.ts`), bundled by each app.
Boundary constraints live in `packages/shared-config/eslint/module-boundaries.mjs` (tags `type:*`, `scope:*`, `layer:*`).
```
apps/
  office-app/        React 19 + Vite SPA for law-office staff        :4200
  client-portal/     React 19 + Vite SPA for office clients (D-003)  :4202
  admin-panel/       React 19 + Vite SPA for platform owner          :4201
  backend-api/       NestJS 11 modular monolith (HTTP + WS)          :3000  (/api/v1, /api/docs)
    src/worker.ts    BullMQ worker entrypoint (same codebase, separate process)
  backend-api-e2e/   Jest + Supertest integration suite
  e2e/               Cypress journeys
packages/
  shared-types/      branded ids, enums (UPPER_SNAKE), envelope types — no runtime deps
  shared-utils/      pure helpers (dates, money w/ decimal.js, Arabic normalization, file numbers)
  shared-contracts/  Zod schemas per resource: CreateXSchema, UpdateXSchema, XResponseSchema, XQuerySchema
  shared-api-client/ typed axios client (auth refresh single-flight, envelope unwrap, 30s timeout)
  shared-ui/         AntD wrappers, theme tokens, layout shell, RTL helpers, i18n provider
  shared-i18n/       translation resources (ar, en) + glossary keys
  shared-config/     eslint, tsconfig, prettier, vite presets
```
**Boundaries (Nx tags, enforced by `@nx/enforce-module-boundaries`):**
`type:app` → may import `type:lib` only; apps never import apps.
`scope:shared` libs: `shared-types` ← `shared-utils` ← `shared-contracts` ← `shared-api-client`;
`shared-ui` may use types/utils/i18n; `shared-i18n` may use types; backend may use types/utils/contracts (never ui/api-client/i18n);
`type:e2e` projects may use libs only. Server-only npm packages (`@nestjs/*`, `@prisma/*`, `bullmq`, `ioredis`, `pg`, `@aws-sdk/*`)
are banned in `scope:frontend`; `react`/`antd` are banned in `scope:backend`. Shared packages are source-only (D-074).

## Backend (apps/backend-api)
Build: webpack + SWC targeting **ES2022** (`.swcrc`; Node 22 runtime). npm packages stay external (resolved from the app's
`node_modules`); only `@nexlegtiq/*` source packages are bundled (D-074). Tests use `.spec.swcrc` with the same target.

NestJS 11 (SWC), Prisma 7 + PostgreSQL 17 (+ pgvector, pg_trgm, unaccent), Redis 7 (ioredis), BullMQ 5
(`@nestjs/bullmq`), Zod 3/4 + `ZodValidationPipe` (contracts from `shared-contracts`), Pino (`nestjs-pino`),
Swagger (`@nestjs/swagger`, zod→openapi), `nestjs-cls` (request context: requestId, userId, officeId),
helmet, `@nestjs/throttler` (Redis storage), socket.io gateway, Sentry.

```
src/
  main.ts / worker.ts
  config/            env.schema.ts (Zod; boot fails on invalid env), config module
  common/            guards (jwt, permissions, tenant, client-portal), interceptors (envelope, logging, timeout),
                     filters (global exception → envelope), pipes (zod), decorators (@CurrentUser, @RequirePermissions,
                     @RequireAnyPermission, @Public), middleware (request-id), exceptions (AppException family)
  infra/             prisma (client + tenant $extends), redis, cache (CacheKeys), queue, storage (S3-compatible),
                     mail (SMTP or Resend; templates AR/EN — D-085, code in src/common/{storage,mail}), crypto (AES-GCM), clamav
  modules/
    auth  users  offices  subscriptions  clients  cases (legal files, parties, team, timeline)  courts
    sessions (+ reminders)  documents (+ folders, versions, ocr)  tasks  billing  search  ai  notifications
    audit  portal (client portal API, separate guard/realm)  admin (platform)  health
```
Module layout: `x.module.ts, x.controller.ts, x.service.ts, x.repository.ts, dto/ (re-export contracts),
x.errors.ts, x.events.ts, __tests__/`. Controllers are thin; services orchestrate; repositories own Prisma.

Service write recipe (dev guide): validate → authorize/scope → write in transaction (officeId from CLS) →
timeline event → enqueue async work → audit log → invalidate cache → structured log.

### Queues (D-011)
| Queue | Priority | Jobs | Retry |
|---|---|---|---|
| `ocr` | high | `process-document` | 3× exp 1s, timeout 60s |
| `ai` | medium | `summarize-document`, `summarize-session` | 2× 10s, timeout 120s |
| `reminder` | high | `send-session-reminder`, `send-task-reminder` (delayed jobs) | 3× exp |
| `email` | low | `send-email` | 3× fixed 5s |
| `notification` | high | `fan-out` (WS + DB) | 3× |
| `report` | low | `invoice-pdf`, `office-export` | 2× |
| `batch-ingest` | medium | Phase 2 (email/voice ingest) | – |
Defaults: removeOnComplete 7d/1000, removeOnFail 30d. Priority = worker concurrency (high 10, medium 5, low 2); timeouts
are enforced by `TenantProcessor`. Code: `src/common/queue/` (`QUEUE`, `QUEUE_POLICY`, `QueueProducer`, `TenantProcessor`),
`UnitOfWork` for after-commit enqueueing. Bull Board at `/admin/queues` only with `BULL_BOARD_ENABLED` (refused in
production until the platform-admin realm guards it; D-084).

### Caching
React Query on the client (staleTime 2m); Redis cache-aside with `CacheKeys` (all tenant keys `o:{officeId}:…`,
D-058); invalidate by explicit keys or `SCAN` patterns (never `KEYS`). Default TTL 5 min; AI results 24h–30d.

### Realtime
socket.io namespace `/ws`, auth via access token, rooms `office:{officeId}`, `user:{userId}`.
Events: `document.processed`, `document.summary.ready`, `session.scheduled`, `session.reminder`,
`task.assigned`, `task.updated`, `notification`, `ai.job.completed|failed`.

## Frontend (office-app, client-portal, admin-panel)
React 19, Vite 8, **React Router 8** (data router: `createBrowserRouter` + `RouterProvider`, D-010), AntD 5 (`ConfigProvider` with theme tokens, `direction`, `locale`), `@ant-design/icons`,
`@ant-design/pro-components` (tables/forms where helpful), TanStack Query 5, Zustand (auth/session/ui stores),
axios via `shared-api-client`, i18next + react-i18next, dayjs (with `ar` locale), `@dnd-kit`, Vitest + Testing Library,
Storybook (+ RTL toggle) for shared-ui. See `frontend.md`.

## Data
PostgreSQL 17 + extensions `pgvector`, `pg_trgm`, `unaccent`, `citext`. Prisma schema at
`apps/backend-api/prisma/schema.prisma`, tables/columns snake_case via `@@map/@map`, every tenant table indexed
`(office_id, …)`. See `domain-model.md`.

## Infrastructure (D-020 lean-first)
| Env | Where | Notes |
|---|---|---|
| local | docker compose (`docker/compose.dev.yml`): `pgvector/pgvector:pg17`, `redis:7-alpine`, `rustfs` (S3), `mailpit`, `clamav` | `pnpm dev:up` |
| CI | GitHub Actions service containers | ephemeral |
| staging | 1 VPS (Docker Compose: api, worker, caddy) + managed PG/Redis (small) + object storage | auto-deploy from `develop` |
| prod | 1–2 VPS (api ×2, worker ×1 behind Caddy) + managed PG (daily backups + PITR) + managed Redis + R2/S3 | deploy from `main` tag, manual approval |
SPAs on Cloudflare Pages (or S3+CloudFront). Secrets in GitHub Environments → injected as env at deploy.
Observability: Sentry (FE+BE), Pino JSON logs → Better Stack/Grafana Cloud free tier, `/health` + `/metrics`
(Prometheus format), UptimeRobot. **Graduate to ECS/RDS** when any of: >50 paying offices, sustained CPU >60%,
enterprise/government contract requiring Multi-AZ/SLA, or DR RTO < 1h required.

## Performance budgets
API P95 < 500 ms (P99 < 1 s), DB query < 100 ms, search < 200 ms, upload ack < 5 s, OCR < 30 s/page-set,
AI summary < 10 s p50 (async), page load < 2 s, TTI < 3 s. Route-level code splitting; vendor chunks for antd/react.
