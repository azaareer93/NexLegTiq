# Decision Log (ADR-lite)

Canonical resolutions of conflicts found across the Notion documentation (read 2026-09-28).
When code, a Jira ticket, or a Notion page disagrees with this file, **this file wins** until a new
entry supersedes it. Add new decisions at the bottom with the next number; never rewrite history —
mark superseded entries instead.

Format: **D-NNN — Title** · Status · Source of conflict → Decision · Why.

---

## Product & scope

**D-001 — Product name and package scope** · Accepted
Docs mix "LawMatik" and "NexLegTiq" (`@lawmatik/*`, `lawmatik_app` DB role, `lawmatik.com` domains).
→ Everything is **NexLegTiq**. npm scope `@nexlegtiq/*`, DB roles `nexlegtiq_app` / `nexlegtiq_readonly`,
buckets `nexlegtiq-*`, API-key prefix `nlq_`, webhook headers `X-NexLegTiq-*`.

**D-002 — MVP scope** · Accepted (owner decision 2026-09-28)
Root page MVP (case mgmt, AI summarization, OCR uploads, document organization, client portal, AR/EN)
vs Roadmap/RICE (AI in Phase 2, no portal).
→ MVP = Roadmap Phase 1 **plus** AI document & session summarization **plus** a limited Client Portal.
Contract analysis, evidence suggestions, similar cases, templates, local court processes, email ingestion
and voice notes stay in Phase 2+. See `product.md#mvp-scope`.

**D-003 — "Not a client portal" vs Client Portal in MVP** · Accepted
→ The office workspace is the product. The Client Portal is a **separate, read-mostly app** (`apps/client-portal`)
with its own auth realm (`ClientUser`, invite + magic link/password), scoped strictly to files the client is
linked to via `FileClient`. Clients can: see case status & next hearing, view/download documents the office
explicitly shares (`Document.sharedWithClient`), view/pay-status of invoices, upload requested documents
into a quarantine folder, and message the office (Phase 2). Clients never see internal notes, tasks,
AI output, audit, or other parties' data.

**D-004 — Launch market & jurisdictions** · Accepted
Palestine is the launch market but the `Jurisdiction` enum lacks it.
→ `Jurisdiction` = `PALESTINE, JORDAN, EGYPT, SAUDI_ARABIA, UAE, KUWAIT, QATAR, OMAN, BAHRAIN, LEBANON, IRAQ, MOROCCO, USA, UK, OTHER`.
Default for new offices: `PALESTINE`. Default currency per office (`ILS`/`JOD`/`USD` common in PS) — stored on Office.

**D-005 — Plans & pricing** · Accepted
Five mutually inconsistent tier tables (entity enum, workflows, business plan, ToS, FAQ).
→ No hard-coded tiers. `Plan` table (code, name, priceMonthly, currency, maxUsers, aiQuotaMonthly,
storageQuotaMb, features JSON, region/market) + `Subscription` (officeId, planId, status, periodStart/End,
trialEndsAt, paymentMethod incl. `CASH`/`BANK_TRANSFER`). MVP seeds Palestine freemium (Free 6 months,
≤5 users, AI 5/month) and the global plans; admin panel assigns plans manually (cash/bank). Online payments
are Phase 4. Feature gating reads `features` flags, never plan names.

**D-006 — Trial model** · Accepted
Workflows say "free trial", onboarding/business say "freemium".
→ Palestine: 6-month freemium plan. Global: 30-day trial with no card. Both are just `Subscription` states.

**D-007 — Case studies / testimonials** · Accepted
Case studies in Notion are illustrative. They must never ship in product, marketing site, or seed data as
real customers.

## Architecture & stack

**D-010 — Frontend React version** · Accepted
React 18.2 (AntD sample) vs React 19 (architecture). → **React 19**, Vite, React Router (v7 data router is
fine; docs said v6 — use whichever current major AntD/tooling supports cleanly and record it in `architecture.md`).

**D-011 — Queue library** · Accepted
Docs import `@nestjs/bull`. → **`@nestjs/bullmq` + BullMQ 5**. Queue names are canonical in `architecture.md#queues`:
`ocr`, `ai`, `email`, `reminder`, `report`, `batch-ingest`, `notification` (no `-queue` suffix in code; prefix via `BULLMQ_PREFIX`).
Workers run in a **separate process** (`apps/backend-api` worker entrypoint) from the HTTP API.

**D-012 — Drag and drop** · Accepted
`react-beautiful-dnd` is deprecated. → **`@dnd-kit`**.

**D-013 — API prefix & route shapes** · Accepted
`/api/...` vs `/api/v1/...`. → `/api/v1`. Tenant-scoped resources never take `officeId` in the path
(`GET /api/v1/offices/me`, not `/offices/:id`). Similar cases: `GET /api/v1/cases/:id/similar` (Phase 2).
Document download returns `200 {downloadUrl, expiresIn}` (JSON, not 302) so the SPA can handle errors.

**D-014 — Async AI & OCR endpoints** · Accepted
API doc shows sync 200, flow doc shows 202. → All OCR/AI work is **async: 202 + job id**, result via
WebSocket event + polling endpoint. Cached results may return 200 immediately.

**D-015 — IDs** · Accepted
Prisma `cuid()` vs Zod `.uuid()` vs INT polymorphic ids. → **UUID v7** everywhere (`@default(uuid(7))`,
Zod `z.uuid()`), branded TS types (`FileId`, `UserId`...). Polymorphic `sourceId` columns are UUID strings.

**D-016 — Enum casing** · Accepted
→ Enum **values are UPPER_SNAKE** in Prisma, Zod, API payloads and DB. Human labels come only from i18n
(`enums.fileType.LITIGATION`). Never display raw enum values.

**D-017 — Money** · Accepted
`Float` retainer balances. → Prisma `Decimal(14,2)` for money, `Decimal(6,2)` for hours; serialize as strings
in the API; currency ISO-4217 code alongside every amount. Never use JS floats for money math (use `decimal.js`).

**D-018 — Tenant isolation mechanism** · Accepted
Docs use Prisma `$use` middleware (removed in Prisma 5+) and a model list that includes tables without `officeId`.
→ **Every tenant-owned table has a non-null `officeId`** (denormalized onto Session, Document, Task, Party,
TimeEntry, Witness, WitnessStatement, AiSummary, AiUsage, Notification, CaseTimelineEvent, …).
Enforcement is layered: (1) `nestjs-cls` holds `officeId` from the JWT; (2) a Prisma **`$extends` query extension**
injects `officeId` into `where`/`data` for tenant models and throws if missing; (3) repositories still pass
`officeId` explicitly; (4) integration tests assert cross-tenant access for every resource;
(5) PostgreSQL RLS is a Phase 3 hardening item.

**D-019 — Cross-tenant access response** · Accepted
Testing doc expects 403 for other office's resources. → **404 `RES-001`** (don't leak existence). 403 is for
same-office permission failures (`AUTH-100`).

**D-020 — Infrastructure target** · Accepted (owner decision 2026-09-28)
Business plan (~$65/mo lean) vs deployment guide (ECS Fargate ×3, Multi-AZ RDS, ~$440/mo).
→ **Lean first, container-ready.** Staging + prod on Docker Compose on a single VPS per env (e.g. Hetzner/DO),
Caddy/Traefik TLS, managed Postgres 17 with pgvector (Supabase/Neon/DO), managed Redis (Upstash/DO),
S3-compatible object storage (R2/S3/Spaces), static SPAs on a CDN (Cloudflare Pages). Same images deploy to
ECS later — graduation criteria in `ops-deploy.md`.

**D-021 — Data residency** · Proposed
FAQ promises AWS us-east-1. With lean infra choose EU region by default (closest to Palestine/Jordan, GDPR
friendly) and update FAQ/DPA sub-processor list before launch. Owner to confirm.

## Domain model

**D-030 — Party ownership** · Accepted → `Party.officeId` required; parties are office-scoped and reused across files (enables conflict check).

**D-031 — File number uniqueness & format** · Accepted
→ `@@unique([officeId, fileNumber])`. Format configurable per office (default `{YEAR}-{TYPE}-{SEQ:5}`,
e.g. `2026-LIT-00001`). Sequence per office+year via a counter row locked in the same transaction
(`FileNumberSequence`). Type codes map from `FileType` (LIT, CON, ADV, CMP, CRS, BUS, NDA, WIL, INC, RNT, EMP)
plus `CRM` for criminal sub-type.

**D-032 — User email uniqueness** · Accepted
→ `User.email` unique **globally** for now (one login = one office) — invites to an email that already exists
return `409 RES-002` with a clear message. Multi-office membership is Phase 5 (will introduce `Membership`).

**D-033 — Missing relations on LegalFile** · Accepted
→ Add `courtId?`, `judgeId?`, `jurisdiction` (defaults from office), `courtCaseNumber?` (the court's own number),
`embedding vector(1536)?` (Phase 2). Multiple clients & team: `FileClient(fileId, clientId, isPrimary)` and
`FileTeamMember(fileId, userId, role: RESPONSIBLE_LAWYER|PARALEGAL|MEMBER)`. Keep `responsibleLawyerId` as a
denormalized column for fast filtering; kept in sync by the service.

**D-034 — Criminal matters** · Accepted → Add `CRIMINAL` to `FileType` (docs use `2025-CR-…` numbers and prosecutors).

**D-035 — Documents** · Accepted
→ Add `status` (`UPLOADED, PROCESSING, READY, FAILED`), `ocrStatus`, `folderId?` (`DocumentFolder` tree per file,
default folders by type), `mimeType`, `sizeBytes`, `checksumSha256`, `storageKey`, `sharedWithClient`, `sessionId?`.
Allowed types for MVP: pdf, docx, doc, jpg, png, tiff, xlsx, csv (FAQ list minus pptx); max 50 MB; malware scan
before READY (ClamAV sidecar); original filename (incl. Arabic) is stored as metadata, storage key is
`{officeId}/{fileId}/{documentId}/{uuid}.{ext}` — never sanitize away Arabic names in the DB.

**D-036 — Session reminders** · Accepted
→ `SessionReminder(scheduledFor, status: PENDING|SENT|FAILED|CANCELLED, channel, sentAt, acknowledgedAt, jobId)`;
reminders are BullMQ delayed jobs keyed by reminder id so reschedule/cancel removes and re-adds them.
Add `Session.courtId?` (hearing can be in a different court than the file's). Session status derived:
`SCHEDULED` when no outcome and not cancelled.

**D-037 — Global reference data** · Accepted
Seeds are global but entities require `officeId`. → Reference tables (`Court`, `Judge`, `LocalCourtProcess`,
`DocumentTemplate`) allow `officeId = null` for platform-provided rows; offices may add their own rows
(officeId set). Queries return `officeId IS NULL OR officeId = :current`. Global rows are read-only to offices.
`Court` gains `jurisdiction`. Court types unified: `CourtType` = `CIVIL, CRIMINAL, COMMERCIAL, LABOR, FAMILY,
ADMINISTRATIVE, SHARIA, MAGISTRATE, FIRST_INSTANCE, APPEAL, CASSATION, SUPREME, ARBITRATION`.

**D-038 — Entities missing from the model (added)** · Accepted
`Plan`, `Subscription`, `FileClient`, `FileTeamMember`, `DocumentFolder`, `FileNote` (notes tab / client profile notes),
`Notification`, `RefreshToken`, `PasswordResetToken`, `ApiKey` (Phase 4), `AiUsage` (with officeId),
`ConsentRecord` / `LegalAcceptance` (ToS/privacy version accepted), `LoginAttempt` (lockout), `InvoiceLineItem`,
`FileNumberSequence`, `ClientUser` + `ClientInvitation` (portal). Deferred: `VoiceNote`, `IngestedEmail` (Phase 2).
`AuditLog` gains `ipAddress`, `userAgent`, `requestId`.

**D-039 — Session outcome / AI source enums** · Accepted
→ `AiSummarySourceType` = `DOCUMENT, SESSION, WITNESS_STATEMENT, COURT_RULING, OPPOSING_BRIEF`.
`TimelineEventType` adds `INVOICE_SENT, INVOICE_PAID, FILE_REOPENED, FILE_REASSIGNED, DOCUMENT_SHARED`.

## Auth & security

**D-050 — Access token storage** · Accepted → Access token **in memory only** (Zustand, not persisted). Refresh token in
httpOnly `Secure` `SameSite=Lax` cookie scoped to `/api/v1/auth`. The dev-guide localStorage example is wrong.

**D-051 — Permission guard semantics** · Accepted
→ `@RequirePermissions(...)` = ALL; `@RequireAnyPermission(...)` = ANY. List endpoints use ANY
(`view:all:cases` | `view:assigned:cases`) and the service narrows the query by which one matched.
The RBAC matrix in `auth-rbac.md` is the single source; `CaseOwnershipGuard` from the dev guide is replaced by
the "assigned" scoping rule: assigned = responsible lawyer, responsible paralegal, or `FileTeamMember`.

**D-052 — Close/reopen/archive permissions** · Accepted → `close:case` and `reopen:case` = OfficeManager, SeniorLawyer,
and the file's responsible lawyer. Archived files are read-only for everyone.

**D-053 — Session timeout & lockout** · Accepted → Idle timeout default 30 min (office-configurable 15–120).
Login lockout: 5 failed attempts / 15 min per account+IP → `AUTH-007` for 15 minutes. Rate limits per `api-conventions.md`.

**D-054 — XSS handling** · Accepted → No global HTML-escaping interceptor (it corrupts stored data). Validate with Zod
(reject control chars / script-like payloads where fields are plain text), render via React (auto-escaped),
`sanitize-html` for any rich text, strict CSP via helmet.

**D-055 — CSRF** · Accepted → Bearer-token APIs need no CSRF token. Cookie-authenticated endpoints (`/auth/refresh`,
`/auth/logout`) require `SameSite=Lax` + Origin allow-list check + custom header `X-Requested-With`.

**D-056 — Field encryption vs search** · Accepted
→ Encrypt at app level (AES-256-GCM) only fields that are **never searched**: national IDs/tax IDs of individuals,
bank details, `Party.notes`, `FileNote` marked confidential, 2FA secrets. Names, phones, case titles/descriptions,
and OCR text stay plaintext in an encrypted-at-rest database (disk/volume + backups encrypted) so FTS works.
Documents in object storage use SSE. Revisit per-office keys (envelope encryption) in Phase 5.

**D-057 — PII before LLM calls** · Accepted
Privacy policy promises "anonymized" text to OpenAI/Google. → MVP ships a `PiiRedactor` (regex + dictionary:
party/client names from the file, phone, email, national-id patterns, IBAN) that pseudonymizes before the
provider call and re-hydrates after. Offices can disable AI entirely (`enableAI=false`). Use provider settings with
zero data retention where available. Disclaimer shown on every AI output.

**D-058 — Search cache & tenant keys** · Accepted → Every cache key that holds tenant data starts with `o:{officeId}:`
(e.g. `o:{officeId}:search:{hash(q)}`). Enforced by a `CacheKeys` helper; raw string keys are lint-banned.

**D-059 — Arabic full-text search** · Accepted → `tsvector` using the `simple` config + `unaccent` + Arabic normalization
(strip tashkeel/tatweel, normalize alef/ya/ta-marbuta) in a SQL function; `pg_trgm` GIN for fuzzy name search.
English stemming via a second `english` tsvector column. Query both, rank with `ts_rank`.

**D-060 — Audit retention** · Accepted → Default 365 days (ToS says 1 year), office-configurable upward only.
UI's "30 days" was wrong.

**D-061 — API keys** · Deferred to Phase 4 → When built: `nlq_{keyId}_{secret}`, lookup by `keyId`, SHA-256 hash of secret,
constant-time compare, scopes. (Doc design of findFirst + bcrypt is broken.)

## Delivery

**D-070 — Branching & PRs** · Accepted
→ `main` = production, `develop` = integration/staging. Branch `MVP-<n>-<kebab-summary>` from `develop`.
PR title `[MVP-<n>] <type>(<scope>): <subject>`; squash merge. Conventional commits with `Refs: MVP-<n>` footer.

**D-071 — Quality gates (pragmatic for solo founder)** · Accepted
Dev guide gates (80% coverage, dup ≤3%, complexity ≤10, 0 lint warnings) apply to `apps/backend-api` domain
services, `packages/shared-*` and security code from day one. UI components: 70% target, raised to 80% before
paid launch. E2E: critical journeys only (auth, create case, upload+OCR, schedule hearing+reminder, portal view).

**D-072 — AI-written code review rule** · Accepted
Per dev guide: auth, tenant isolation, schema/migrations, billing/money and legal-data logic always get a human
review before merge (PR label `needs-human-review`, enforced by `/ship`).

**D-073 — User Guide** · Open
Notion "User Guide / Help Center" is blank. Tracked as a Release Readiness story; in-app help links point to it.

**D-074 — Shared packages are source-only** · Accepted (MVP-28, 2026-09-29)
Architecture lists `packages/shared-*` without saying whether they are built. → Shared packages are **non-buildable TS
source packages**: `exports` point at `src/index.ts`, consumers declare them as `workspace:*` deps, and each app's bundler
(webpack+SWC, Vite) and test runner compiles them. Third-party deps a package uses at runtime (e.g. `zod`) are also declared
by the consuming app so they resolve from its bundle. Why: no library build step or publish pipeline to maintain for a solo
founder; one source of truth. Revisit if a package must be published (e.g. an SDK for the Phase 4 API) or build times hurt.

**D-075 — HTTP status per error code** · Accepted (MVP-32, 2026-09-29)
api-conventions.md listed codes without statuses. → The status of every code is defined once in
`apps/backend-api/src/common/errors/error-catalog.ts` (codes themselves in `shared-types`). AUTH-001..005/008/009 → 401;
AUTH-006/010/100..103 → 403; AUTH-007 → 423; VAL-* → 400 except VAL-005 → 415, VAL-006 → 413; RES-001 → 404;
RES-002/003 → 409; RES-004 → 410; BIZ-* → 422 except BIZ-004/009 → 409; AI-001 → 503, AI-002 → 429, AI-003 → 413,
AI-004 → 502, AI-005 → 403; STO-001..003, EXT-* → 502; STO-004 → 422; RATE-001 → 429; SYS-001, DB-001 → 500; SYS-002 → 503.
Framework errors (unknown route, bad JSON, body too large, other Nest HttpExceptions) map to 401 AUTH-003, 403 AUTH-100,
404 RES-001, 409 RES-003, 413 VAL-006, 415 VAL-005, 429 RATE-001, 503 SYS-002, any other 4xx → VAL-001 (status kept), any
other 5xx → SYS-001 — always with the code's generic message, never echoing client input. A `ZodError` thrown by server code
is 500 SYS-001 (only the request pipe produces VAL-001). Why: one table for clients and tests; no leaks.

**D-076 — Request ids** · Accepted (MVP-32, 2026-09-29)
→ An incoming `x-request-id` is reused only if it matches `^[A-Za-z0-9._:-]{8,128}$`; otherwise a UUID is generated. The id
is echoed in the `x-request-id` response header and `meta.requestId`, and bound to every log line of the request. Callers can
choose it, so it is a correlation id only — never evidence of identity in audit or security decisions. Why: lets the SPAs and
support correlate a user report with server logs without allowing header or log injection.

**D-077 — Claude Code add-ons** · Accepted (MVP-4, 2026-09-29)
Owner asked for OmniRoute, claude-mem, Headroom, claude-code-setup, task-observer, Ponytail, Graphify and Agent Skills.
→ **Project-wide** (committed, every clone/cloud session): plugins `claude-code-setup` (official, read-only recommender),
`ponytail` (minimal-code mode) and `agent-skills` (addyosmani, lifecycle skills) via `.claude/settings.json`; `task-observer`
vendored as a project skill with its workspace pinned outside the repo; Graphify (tree-sitter code graph, local, code-only)
wired per machine with `graphify claude install --project`, output git-ignored. **Per-machine opt-in only, never committed:**
Headroom (local compression proxy; beacon off) and claude-mem (second memory system — Ruflo stays the curated memory;
no hosted-observer sign-in). **Not used for this repo:** OmniRoute — it re-routes Claude Code to arbitrary/free-tier models,
which lowers quality on security-critical code and sends code to providers without zero-retention terms; for the product's
own AI calls D-057 (zero-retention providers, PII redaction) governs any gateway choice. Project rules always outrank plugin
skills (see CLAUDE.md "Precedence"). Why: take the quality/context wins without a second source of truth or an unreviewed
traffic path. Details and commands: `docs/tooling.md`.

**D-078 — Local dev stack and production config guards** · Accepted (MVP-30, 2026-09-29)
MVP-30 needed an S3 emulator and the ticket left the config rules implicit. → `docker/compose.dev.yml` runs
Postgres 17 + pgvector, Redis 7, **RustFS** (S3-compatible, Apache-2.0: MinIO stopped publishing community images, and
`minio/minio` is gone from Docker Hub), Mailpit and ClamAV. No `:latest` images; every port binds to `127.0.0.1`.
Extensions (`vector`, `pg_trgm`, `unaccent`, `citext`) are installed in `template1` so the Prisma shadow database and
`nexlegtiq_test` inherit them; migrations still `CREATE EXTENSION IF NOT EXISTS` for managed databases. The app connects
as the superuser locally (the `nexlegtiq_app` role split of D-001 lands with MVP-33 migrations). Backing-service env vars
have no defaults (boot fails closed); `BULLMQ_PREFIX` defaults to `nlq`. In **production** the env schema also requires
TLS in transit — `DATABASE_URL` with `sslmode=require|verify-ca|verify-full`, `rediss://`, `https://` S3, SMTP
`requireTLS` unless implicit TLS — and rejects the documented dev/CI placeholder credentials (also the only values the
gitleaks allowlist accepts). CI has no S3/mail/ClamAV containers until a job needs them. Why: one-command local setup
without an unmaintained image, and a misconfigured production boot fails instead of running over plaintext.

**D-079 — Base schema choices left open by the domain model** · Accepted (owner, MVP-33, 2026-09-30)
→ Prisma 7.10 (`prisma-client` generator, CommonJS output in `src/generated/prisma`, git-ignored, generated on
`pnpm install`) with the `pg` driver adapter. `RefreshToken` covers **office users only** (admin-panel and portal sessions
get their own tables), with `familyId` for reuse detection. `LoginAttempt` is **global** (recorded before login, when the
email may match no user). `LegalAcceptance.userId` is required until the portal adds `clientUserId`. **One live
subscription per office**: partial unique index on `subscriptions(office_id) WHERE status IN ('TRIALING','ACTIVE')`.
`AuditLog.officeId` is required; platform-level events without an office are decided with the admin panel. Audit
append-only is enforced by **grants** (`docs/runbooks/db-roles.sql`), not a trigger, so retention purge can run as the
migrator. CHECK constraints: `audit_retention_days >= 365`, `session_idle_minutes` 15–120. Plans are seeded
create-only by `code` (the admin panel owns later edits); storage quotas and global AI quotas are provisional (not in
the specs). `nlq_normalize_ar()` is IMMUTABLE and excludes `unaccent` (STABLE); callers compose it. Why: owner-approved
plan (Jira MVP-33 comment 10044).
Review additions (same PR): tenant child rows reference users through composite FKs `(user_id, office_id) → users(id,
office_id)`, so a token, invitation, acceptance, notification or audit row can never name a user of another office.
Audit FKs are `RESTRICT` on delete and update (FK actions run as the table owner, so `SET NULL` would let the app role
rewrite the log); users are deactivated, never deleted. The init migration revokes UPDATE/DELETE on `audit_logs` from
`nexlegtiq_app` when the role exists; `db-roles.sql` also creates the extensions as admin, revokes database access from
PUBLIC, and gives `nexlegtiq_readonly` no access to token tables or `password_hash`/`mfa_secret`. One PENDING
invitation per office + email (partial unique index). `nlq_normalize_ar` also folds hamza seats (ئ → ي, ؤ → و).
Conventions deliberately not applied: append-only/immutable rows (tokens, LoginAttempt, LegalAcceptance, AuditLog,
Notification) have no `updatedAt`; `AuditAction` adds `SECURITY` (token-reuse events, auth-rbac.md);
`Subscription.currentPeriodStart/End` (D-005 said periodStart/End), `paymentMethod` defaults to `NONE` and includes
`CARD` (Phase 4); `clientUserId` on AuditLog/Notification/LegalAcceptance arrives with the Client Portal. Plan prices
come from product.md (USD). **Amends D-078:** dev Postgres listens on host port **5434** (5432/5433 are commonly taken),
`.env.example` uses `127.0.0.1` (compose binds IPv4 only; Node on Windows resolves `localhost` to `::1`), and the
role split is the `docs/runbooks/db-roles.sql` runbook, not part of migrations.

**D-080 — Tenant extension shape and limits** · Accepted (MVP-37, 2026-09-30)
MVP-37 left the enforcement details of D-018 open. → `PrismaService.db` is the **scoped** client (Prisma `$extends`,
`src/common/tenancy/`); `PrismaService.unscoped()` is the raw client for migrations, seeds, signup/login before an office
is known and platform-admin code, and every access needs a `// unscoped: <reason>` comment (local lint rule
`nexlegtiq/unscoped-needs-reason`, **error**; also catches `['unscoped']`, `.call` and destructuring). The raw client is an
ES `#private` field. On the scoped client: tenant models get `officeId` in every `where` and created row, and a different
`officeId` (value or filter) is rejected; **relation writes into tenant models or Office are rejected at any depth** —
tenant rows are written with scalar foreign keys, which composite `(…, office_id)` FKs check (D-079, now also
`refresh_tokens.replaced_by_id`); into global models only `connect`/`disconnect`. `Office` is limited to the current
office's row (create/delete need `unscoped()`). **Global models (Plan, PlatformAdmin, LoginAttempt) are read-only.**
Relation filters (`some`/`none`/`is` get the office; `every` judges only the office's rows), includes/selects/`_count`
that reach tenant rows through a global model are scoped, and ordering a global model by a tenant relation is rejected.
Raw `$queryRaw`/`$executeRaw` touching a tenant table must take the current `officeId` as a parameter; `*Unsafe` and
`U&"…"` identifiers are rejected (runtime + lint). Unknown operations fail closed. Violations are programming errors →
500 SYS-001 (not 404): a correct request never reaches them. `TenantRunner.run` always starts a fresh CLS context
(`ifNested: 'override'`). Relation metadata comes from the client's internal `_runtimeDataModel`, checked at boot.
**Known limits:** the raw-SQL guard matches table names and only checks the officeId is *among* the parameters (views or
functions reading tenant tables are not seen); D-037 reference tables (`officeId` nullable = "global or own") will need a
third category in the extension. Phase 3 RLS is the backstop. The data-layer isolation matrix
(`tenant-isolation.matrix.ts`, every tenant model, two offices, real PostgreSQL) runs in the `integration` target; its HTTP
half (404 RES-001 per endpoint) is added per resource once MVP-40 provides auth. Why: isolation by construction without a
hand-maintained relation list, and loud failures instead of silent cross-tenant reads.

**D-081 — RBAC enforcement details and scope split** · Accepted (MVP-38, 2026-10-01)
MVP-38's AC assumed login (MVP-40) and the legal-file model (MVP-57) already existed. → `packages/shared-types/src/permissions.ts`
holds `ROLES`, `PERMISSIONS` and `ROLE_PERMISSIONS` (matrix rows of auth-rbac.md, guarded by an independently transcribed
table test). The two conditional cells are data, not prose: `PERMISSION_CONDITIONS` = LAWYER `close:case`/`reopen:case` →
`RESPONSIBLE_LAWYER` (D-052), EXTERNAL_COLLABORATOR `complete:task` → `OWN`; the role holds the permission and the service
must check the condition. **Permissions are derived from the role on every request** (guard and CLS), never read from the
token, so a role change applies immediately; `AuthPrincipal` is `{userId, officeId, role, realm}`. `PermissionsGuard` is a
global `APP_GUARD` (the JWT guard of MVP-40 must be registered before it): no decorator → not checked; decorator without a
principal → 401 AUTH-003; denied → 403 AUTH-100 plus a best-effort `PERMISSION_DENIED` audit row in the caller's office
(audit failure is logged, never turns 403 into 500). `caseScope()` / `assignedFilesWhere()` implement D-051 "assigned"
(responsible lawyer, responsible paralegal, `teamMembers`); the DB-backed `CaseAccessService.assertFileAccess` ships with
MVP-57 when LegalFile/FileTeamMember exist, and "login response includes `permissions[]`" ships with MVP-40 (it returns
`permissionsFor(role)`). Frontend: `PermissionsProvider` + `useCan` + `<Can>` in shared-ui — UI hiding only, the API always
re-checks. Review additions (same PR): only `realm: 'OFFICE'` principals get office role/permissions (guard denies
others, the interceptor sets no role/permissions for them); class- and method-level requirements must **both** pass;
conditional cells count as held only on routes marked `@PermissionConditionsCheckedByService()` (fail closed);
`permissionsFor` is total (unknown role → no permissions); the matrix is frozen; the audited user agent is capped at 512
chars. "Role change applies immediately" requires the MVP-40 JWT guard to reload `role` and `isActive` from the database
(or an office-tagged cache) on each request, never trusting the token's role. `TenantRunner.run` awaits the work inside
the CLS context because Prisma queries are lazy (`() => prisma.db.x.create()` otherwise ran without an office — caught by
the guard's integration test). Why: one matrix, no stale grants in tokens, and no code written against tables that do not
exist yet.

**D-082 — Office authentication details** · Accepted (owner chose Argon2id; MVP-40, 2026-10-01)
→ Passwords: **Argon2id** (`@node-rs/argon2`, OWASP minimum m=19 MiB, t=2, p=1; parameters live in each hash, so raising
them later only affects new hashes); unknown emails and non-Argon2 stored hashes are verified against a dummy hash (no
timing oracle) and get the same 401 AUTH-001 as a wrong password. Access JWT: HS256 with `JWT_SECRET` (≥32 chars, required,
no placeholder in production), `iss=nexlegtiq`, `aud=office`, 15 min, claims `{sub, officeId, role, sid}`; `role` is
informational and `sid` (the refresh family id) is reserved for revoking access tokens early — neither is read today.
`JwtAuthGuard` is a global guard (**deny-by-default**, `@Public()` from `common/auth` opts out) and reloads `role`,
`isActive` and the office's `isActive` on every request (D-081): inactive user or suspended office → 403 AUTH-006 (login,
refresh and Bearer alike), expired token → 401 AUTH-002, anything else → 401 AUTH-003. Refresh: opaque 32 random bytes in
the `nlq_rt` cookie, SHA-256 at rest, 7 or 30 days; a rotation keeps the token's lifetime, but no session outlives
**90 days** from its login (then AUTH-004); the old token is claimed with a conditional update, so a replayed **or
concurrently reused** token revokes the whole family (+ `SECURITY` audit). The SPA must therefore serialize refreshes across
tabs. Refresh clears the cookie only when the session is dead (AUTH-004/005/006). Logout revokes the family and is an
idempotent 204 (no cookie, an unknown or already-revoked token: nothing revoked, nothing audited); access tokens already
issued stay valid until they expire (≤15 min). Every session write and its audit row share one transaction.
CSRF on refresh/logout (D-055): allowed `Origin` **and** `X-Requested-With: XMLHttpRequest`, else 403 AUTH-100 — a missing
`Origin` is rejected too. Lockout (D-053): 5 failures for the same email + IP since that pair's last success, all within
15 min, lock the pair for **15 min from the 5th failure** (fixed window; attempts while locked are refused before they are
recorded, so they do not extend it) → 423 AUTH-007. Login by an inactive user or office is recorded as a failure (it never
resets the counter). Every attempt is a `LoginAttempt` row (index `email, ip_address, attempted_at`). Lockout and rate
limits key on the client IP, so production requires `TRUST_PROXY_HOPS` ≥ 1 (boot fails otherwise). Rate limits via
`@nestjs/throttler` as a global guard (before authentication): default 100/min per IP, login 5/min, refresh and logout 30/min,
429 RATE-001 + `Retry-After`; health probes are exempt. **Deviation from api-conventions.md:** limits are per IP, not ip+user
(no user is known before login) and **in-memory** until Redis is wired (one API container, D-020). No per-account limit across
IPs yet (a distributed guess against one email is only slowed per IP). `@nestjs/jwt` is pinned to 11.x (12 is ESM-only; the
backend is CommonJS). `JWT_REFRESH_SECRET` is not used (refresh tokens are opaque). Why: OWASP-grade storage, sessions
revocable within one request, and replay of a stolen refresh token kills the session.

**D-083 — Office signup and email verification** · Accepted (owner chose schema, plan mapping, the email split, the
enforcement flag and reclaiming abandoned signups; MVP-39, 2026-10-01)
→ `POST /auth/register` (5/min per IP) creates, in **one transaction on the raw client** (the office does not exist yet,
D-080): Office (`accountType` SOLO|FIRM|CORPORATE, new column), OfficeSettings (schema defaults: reminders 7/3/1, file
number `{YEAR}-{TYPE}-{SEQ:5}`), the OFFICE_MANAGER user (Argon2id, `uiLanguage` EN only for an English office, else AR),
a `TRIALING` subscription, ToS + Privacy `LegalAcceptance` rows, the verification link and a `CREATE Office` audit row.
**Plan:** jurisdiction PALESTINE → `PS_FREE` (180 days); elsewhere a 30-day trial sized by account type: SOLO →
`GLOBAL_SOLO`, FIRM → `GLOBAL_SMALL_FIRM`, CORPORATE → `GLOBAL_PROFESSIONAL`; `trialEndsAt = currentPeriodEnd = now +
plan.trialDays`; a missing or inactive plan is a deployment fault (500 SYS-001, nothing written). **Legal versions** are server constants (`LEGAL_VERSIONS`, bumped when a text changes); the client only
sends `acceptTerms: true` and `acceptPrivacy: true`. Then the manager is logged in like `/auth/login` (201 + session +
cookie) in a second, scoped transaction — a failure there leaves a complete office: on a 5xx after signup the client
offers /auth/login (a retry would get 409). An existing
email → 409 RES-002 (D-032; a racing duplicate loses on the unique index). **Password policy** follows auth-rbac.md (≥10,
upper + lower + digit, not a well-known password, not the email), not the Notion onboarding page's 8+; the common list is
short (a breached-password check can replace it). Names reject control characters and bidi overrides/isolates (ZWJ/ZWNJ
allowed); `currency` must be an ISO-4217 code the runtime knows (`Intl.supportedValuesOf`). **Email verification:** `User.emailVerifiedAt` + `EmailVerificationToken`
(32 random bytes, SHA-256 at rest, 7 days, single use, tenant table hidden from the read-only role). `POST /auth/verify-email`
→ 204; an unknown, used or expired link → **410 RES-004** (not 401, so the SPA's refresh-on-401 never fires on a public
link; 10/min per IP); only a real change writes the `UPDATE User {emailVerified}` audit row. Login and refresh responses
carry `emailVerified` and `verifyBy` for the banner. **Enforcement is behind `EMAIL_VERIFICATION_ENFORCED`** (default
`false`): when on, 7 days unverified → login, refresh and every Bearer request get **403 AUTH-010** (refresh also revokes
the session; a correct-password login is still recorded as a success, so retries never turn AUTH-010 into AUTH-007 lockout).
It stays off until the email adapter story ships sending + resend, because nobody can verify before that. **Reclaiming
abandoned signups** (only while enforced): a signup for an email whose user never verified within 7 days and is the only user
of its office releases that account in the same transaction — the office is deactivated, its sessions and links end, the
user is deactivated and its email renamed to `released+{userId}@invalid.nexlegtiq` (nothing deleted: audit FKs are RESTRICT),
with a `SECURITY` audit row in the released office; a verification racing the reclaim wins (409). Accounts that existed
before the migration (seeds, invitations) are backfilled as verified, and **accepting an invitation must set
`emailVerifiedAt`** (the link proves the address). **Sending** the AR/EN email, and a resend endpoint, belong to the email
adapter story: until then `VerificationMailer` logs that delivery was skipped (never the token), and a hand-off failure never
fails the signup. Why: one-step freemium signup now, without building email delivery twice, and no account can be locked
out or squatted for good.

**D-084 — Queue infrastructure details** · Accepted (MVP-34, 2026-10-03)
MVP-34 left the library versions, producer/consumer shape, timeouts, Bull Board access and test Redis open. →
`@nestjs/bullmq` pinned to **11.x** (12 is ESM-only; the backend is CommonJS, as for `@nestjs/jwt` in D-082) with **BullMQ
5** (D-011; 6 is a new major). `src/common/queue/`: `QUEUE` (the seven canonical names) and `QUEUE_POLICY` (attempts,
backoff, timeout, concurrency per architecture.md; priority = worker concurrency high 10 / medium 5 / low 2; retention 7 days
or 1000 completed, 30 days failed; the table leaves some cells blank, filled as: reminder/notification exponential 1 s with a
30 s timeout, email 30 s, report exponential 1 s with 120 s, batch-ingest 1 attempt / 120 s / concurrency 5). `QueueModule`
(global, both processes) registers every queue from `REDIS_URL` + `BULLMQ_PREFIX`, attaches error listeners as the queues
are created (an unhandled `error` event would crash the process) and the `redis` readiness check (PING). **Producers:** `QueueProducer.enqueue(queue, name, fields)` is the only way to enqueue; it adds `officeId` and
`requestId` from CLS (`TenantContextMissingError` outside a tenant context, and a smuggled value is overwritten); the field
types forbid callers from passing them. Callers may set only `jobId` (stored as `{officeId}_{jobId}`, so offices never collide),
`delay` and `priority`. An enqueue gives up after **2 s** while Redis is unreachable instead of hanging the request (ioredis
would queue the command through minutes of reconnects; the command may still run once Redis is back, which is fine after a
commit). `enableOfflineQueue: false` is not used: BullMQ 5 sends commands while connecting and breaks with it. **Consumers:** processors extend `TenantProcessor` and declare a Zod `schema` for their fields. It validates the tenant part
and the fields (invalid → `UnrecoverableError`, no retries: Redis is a trust boundary), drops a request id that is not
D-076-safe, runs `handle(job, signal)` in `TenantRunner` with the job's office and request id, **skips jobs whose office has
been suspended** (D-082), applies the queue timeout — failing the attempt and aborting `signal`, which handlers pass to
HTTP/SDK calls so a timed-out attempt stops instead of running alongside its retry — and logs failed attempts with queue,
job id, attempt and request id (`command` is redacted from logged errors: ioredis puts job payloads there); they are registered only in `WorkerModule`, so the HTTP app is producer-only. **After commit:**
`UnitOfWork.run((tx, afterCommit) => …)` runs tasks in order after the transaction commits and never after a rollback;
registering a task after the transaction ended throws; a task failing after commit is logged with its label, not thrown (the
data is committed) — a transactional outbox replaces this if lost jobs ever
matter more than a retry endpoint. **Bull Board** at `/admin/queues` (unprefixed, plain Express middleware, so no Nest guard
sees it) is mounted only with `BULL_BOARD_ENABLED` (default `false`), which the env schema **refuses in production** until the
platform-admin realm can guard it; helmet's headers apply to it except the CSP, which would block its scripts. **Tests:** integration tests use real Redis (local stack or the CI service) — BullMQ runs
Lua scripts that in-memory fakes do not, so the ticket's "in-memory switch" is not provided; `integrationEnv()` gives real
`DATABASE_URL`/`REDIS_URL`, queue tests use a random `BULLMQ_PREFIX`, `drainQueue()` waits until a queue has no pending work,
and unit tests that build the app without Redis replace `QueueModule` with `QueueStubModule`. Why: tenant context can't be
forged or forgotten by producers, jobs can't leak across offices, and a Redis outage degrades instead of crashing.

**D-085 — Storage and email adapters; verification links are created by the worker** · Accepted (owner chose the token flow; MVP-35, 2026-10-03)
→ **Storage** (`src/common/storage`, AWS SDK v3, S3-compatible): `StorageService.keyFor(...segments)` builds
`{officeId}/…` from the request/job context (segments `[A-Za-z0-9._-]` only, no `..` or `/`), and `put` (streamed, multipart),
`getStream`, `head`, `delete` (idempotent) and `presignedGetUrl` (300 s default, at most 900 s, D-013; always served as an
`attachment` under `filename` or the key's last segment — RFC 6266/5987, so Arabic names survive — never inline from the
storage domain) all refuse any key whose first segment is not the current office or whose other segments are not
`[A-Za-z0-9._-]` (`TenantViolationError`), even a key read back from the database. The S3 client has a 5 s connect and 30 s
idle timeout. Failures:
STO-001 upload, STO-002 download/lookup/link, STO-003 delete; a missing object is RES-001 (`head` → null). `S3_SSE`
(`AES256` | `none`, default `none`) sets the SSE header on uploads: AWS S3 takes AES256 (production refuses an
`*.amazonaws.com` endpoint without it); RustFS rejects the header and R2 encrypts at rest on its own. A `storage` readiness check runs HeadBucket. **Email** (`src/common/mail`): `MailService.send(to,
template, locale, vars)` enqueues `email/send-email`; the worker renders and delivers. Templates (`verify-email`, `invite`,
`password-reset`, AR/EN) are Handlebars kept in code (no assets to bundle; strict variables; HTML escaped, subject and text not),
each with a Zod schema for its variables, inside one layout with `lang`/`dir` on `<html>` and the content table, alignment from
the direction (email clients ignore logical CSS), installed-font stacks per language (Tahoma/Segoe UI for Arabic), user values
isolated (`<bdi>`, FSI/PDI in subject and text), a plain-text fallback link under every button, Arabic number agreement for
durations (يومين، 7 أيام، 14 يومًا) and footer links to `{OFFICE_APP_URL}/legal/terms|privacy` (the office app must serve
them). The brand is text until a logo is hosted. `EMAIL_PROVIDER=smtp|resend` (default smtp; `RESEND_API_KEY`
required for resend, redacted in logs): nodemailer with the D-078 TLS rules and timeouts inside the 30 s attempt (10/10/15 s), or
the Resend HTTP API (no SDK; an `Idempotency-Key` per job, or per attempt for verification, whose link changes on retry).
Temporary failures (network, 429, 5xx) are EXT-001 and retried; other 4xx, an unknown job, invalid variables or a link that
does not point into the office app fail the job at once. Errors carry the provider's codes, never its message (SMTP replies
quote the recipient). `OFFICE_APP_URL` (https in production) is the base of every link.
**One `EmailProcessor`** consumes the `email` queue (BullMQ gives every job of a queue to its workers, so one processor per
queue); it lives in `src/worker/` because it joins mail delivery with auth's link creation. **Verification links (amends
D-083):** signup and `POST /auth/resend-verification` (`{email}`, public, 3/min per IP, always 202 so it never reveals an
account) enqueue `send-verification-email {userId}` only; the worker, in the user's office, ends earlier unused links, stores
the SHA-256 of a new 7-day token and emails the raw link in the user's language — no secret ever sits in Redis or on Bull
Board, and a retried job just issues another link. Resend only sends to an unverified, active user of an active office,
and the worker issues at most one link a minute (a retry of the same job is exempt) and five a day per user, whatever the
number of IPs asking — no inbox flooding, no killing the link just sent. Signup no longer creates the link itself. Password-reset and invitation emails will follow the same pattern.
`EMAIL_VERIFICATION_ENFORCED` stays off by default: turn it on per environment once its mail delivery is configured. **Tests:**
`integrationEnv()` targets the dev stack's RustFS and Mailpit at fixed 127.0.0.1 addresses (Nx loads the developer's `.env`,
and `localhost` is ::1 on Windows); CI starts the same containers in a step (RustFS needs a command argument services cannot
pass). **Amends D-078:** CI now runs storage and mail containers. **Amends D-084:** BullMQ 5.81 re-emits a connection's failed start
as 'error' after `close()` removed its listeners (Redis unreachable at shutdown → thrown); `QueueModule` drops such events. Why: provider-agnostic storage and email with the tenant
prefix enforced in one place, and no token ever stored outside the database's hash.

**D-086 — Password reset and change details** · Accepted (MVP-41, 2026-10-03)
→ `POST /auth/forgot-password` (`{email}`, public, 5/min per IP) always answers 200 with the same body. Only for an active
user of an active office it enqueues `send-password-reset {userId}` — **without awaiting** the enqueue, so a known email
does not answer measurably slower than an unknown one (`resend-verification` now does the same). The worker
(`PasswordResetLinks`, the D-085 pattern) ends earlier unused reset links, stores the SHA-256 of a new **1-hour** token and
emails the AR/EN `password-reset` template to `{OFFICE_APP_URL}/reset-password?token=…` (the office app must strip the token
from the address bar on load and serve that route with `Referrer-Policy: no-referrer`). Per-user limits are shared with
verification links (`link-limits.ts`: 1 link a minute, retries exempt) but reset links are capped at **5 per hour** — their
lifetime — not 5 a day: when the cap is hit the newest link is still valid, so nobody can block a victim's reset for a day by
asking five times. `POST /auth/reset-password` (`{token, newPassword, confirmPassword}`, public, 5/min)
applies the password policy (incl. "not the email"); unknown, used or expired links, and those of a deactivated user or a
suspended office (D-082) → **410 RES-004**. One transaction claims the link (conditional update that also re-checks expiry,
so concurrent use fails), sets the new hash, ends every other reset link,
revokes **all** the user's refresh tokens, marks the email verified (only its owner could open the link) and writes a
`UPDATE` audit row (`{passwordReset: true}`); 204, the user signs in again. `POST /users/me/password`
(`{currentPassword, newPassword}`, authenticated, 5/min, no permission needed — it is the caller's own account): a wrong
current password is **400 VAL-001 on `currentPassword`**, not 401, so the SPA's refresh-on-401 never fires; the new
password must differ from the current one. It revokes every refresh-token family **except the caller's** — the JWT guard
now puts `sid` on the principal as `sessionId` (correlation only, never used for authorisation) — ends pending reset
links and audits `{passwordChanged: true}`. Already-issued access tokens stay valid until they expire (≤15 min, D-082).
**Refresh rotation locks the user row** (`SELECT … FOR UPDATE`, before the claim) and a reset/change updates that row before
revoking, so a rotation racing a reset cannot insert a refresh token the revoking statement misses (READ COMMITTED).
**Known limit:** wrong current passwords are only rate-limited per IP (5/min), not counted in the D-053 lockout — a stolen
access token allows slow guessing for its 15 minutes.
**Amends D-083/D-085:** `VerificationMailer` became `AccountMailer` (verification and reset jobs); D-085's "password-reset
emails will follow the same pattern" is done here (invitations remain); a reset also verifies the email (D-083).
Why: no account enumeration through answers or
timing, a stolen session dies with a reset, and a password change does not sign the user out of the device they used.

**D-087 — i18n infrastructure and Ant Design 6** · Accepted (owner chose AntD 6; MVP-44, 2026-10-05)
→ **AntD 6** (not 5 as CLAUDE.md said): the current major supports React 19 natively, while AntD 5 needs a compatibility
shim; no UI existed yet. `i18next` 26, `react-i18next` 17, `dayjs` 1.11 and `antd` 6 are root dependencies like `react`.
**Resources** live in `packages/shared-i18n/src/locales/{ar,en}/<namespace>.json`, namespaces `common`, `auth`, `errors`
(every `ERROR_CODES` entry), `enums` (`enums.<enumName>.<VALUE>` for every shared-types enum: jurisdiction, accountType,
officeLanguage, role — a test fails when shared-types exports a new value list without labels; permission labels come with
the roles screen), `legal` (the glossary) and `validation` (every message key shared-contracts and the API send); new
features add their own namespace. They are bundled (no HTTP backend: small files, and no screen ever renders raw keys while
loading), imported with `with { type: 'json' }` (Vite and Vitest handle it; shared-i18n is never built, D-074).
`fallbackLng` is Arabic (unreachable while parity holds). **Keys are written with their namespace first** (`errors.AUTH-001`, `legal.plaintiff`, `common.actions.save`):
`nsSeparator` is `.`, which i18next applies only when the first segment is a known namespace, so the documented
`errors.<CODE>` / `enums.<Enum>.<VALUE>` forms work as written. **Typed keys** come from the English JSON through
i18next's `CustomTypeOptions` (all namespaces declared as the typed default, `common` first) — no generator to run or
forget; an unknown key fails `typecheck`. **Parity check:** `findMissingKeys` reports a key present in one locale only and a
plural key missing a form its locale needs (`Intl.PluralRules`: Arabic zero/one/two/few/many/other, English one/other);
it runs over the real resources in the `shared-i18n` test target, which is the CI check (no separate script); the
target's Nx inputs include shared-contracts, the backend modules and `glossary.md`, so `nx affected` reruns it when they
change. Key suffixes `_zero|_one|_two|_few|_many|_other` are reserved for plurals. The same
target checks that every error code, enum value, glossary term and contract validation key has a translation.
**`LanguageProvider` + `useLanguage()`** (shared-ui) replace `DirectionRoot`: they set `<html lang dir>` (AntD portals
follow), the i18next language, AntD `ConfigProvider` direction and locale (`ar_EG` / `en_US`) and the dayjs locale
together, in a layout effect (no frame painted in the wrong direction); a new `userLocale` is adopted in the same render. The language is the signed-in user's `uiLanguage` (prop `userLocale`), else the last choice on this device
(`localStorage` `nlq.locale`, a convenience only; unavailable storage is ignored), else Arabic. Only an explicit pick
is stored, never the signed-in user's language (a shared office computer must not inherit it); signing out keeps the
language on screen until reload. Saving a choice to the
user's profile is the `onLocaleChange` callback — wired when `PATCH users/me` and the API client exist. dayjs's Arabic
locale gives Western digits because its `preParsePostFormat` plugin is not loaded; Arabic-Indic digits as a user setting
come with the formatting utilities. **Lint** (`packages/shared-config/eslint/no-literal-string.mjs`, apps and shared-ui, `src/**/*.tsx`, tests excluded,
itself tested): `i18next/no-literal-string` on JSX text and a list of user-facing attributes (`title`, `placeholder`,
`alt`, `aria-label`, `label`, `tooltip`, `okText`…; technical props stay free), and `react/no-danger`. **Not caught:**
strings in objects and calls (`columns={[{ title: '…' }]}`, `message.error('…')`) — reviews check those. **XSS:** i18next
does not escape (`escapeValue: false`, React does), so `t()` output is never used as HTML and `<Trans>` values are plain
text; rich text goes through `sanitize-html` (D-054). Server packages (`@nestjs/*`, `@prisma/*`, `@aws-sdk/*`…) are now also
banned in the `layer:ui` and `layer:i18n` packages, which ship in the SPA bundles.
Why: one source of strings for three apps, missing
translations caught at build time, and direction switched in one place.

**D-088 — Design tokens, Arabic UI font and shared-ui components** · Accepted (owner chose IBM Plex Sans Arabic; MVP-43, 2026-10-05)
→ **Font:** IBM Plex Sans Arabic for the Arabic UI (OFL; designed for interfaces, seven weights, sober tone), Inter for
English, Amiri stays for documents/PDF. Both stacks start with Inter, which has no Arabic glyphs, so Latin words and digits
look the same in both languages and Arabic falls through to Plex. Fonts are **self-hosted** from `@fontsource` packages
(only Plex's Arabic subset, weights 400–700; Inter variable): the apps' Vite build copies the woff2 files into their own
assets, so no font CDN is contacted at runtime. **Theme:** `nexTheme(locale)` in `packages/shared-ui/src/theme` holds the
frontend.md tokens (colours, radii, shadows, control heights, heading sizes) and, in Arabic, the Plex stack, 15px and
line-height 1.8. frontend.md's grey "container" colour is applied as AntD's page background (`colorBgLayout`); `colorBgContainer`
(inputs, cards, tables, default buttons) stays white. AntD emits its tokens as CSS variables with the `nlq` prefix
(`--nlq-color-primary`…), which custom CSS uses instead of literal values. A test keeps text/primary colours at WCAG AA contrast.
The runtime packages shared-ui uses (`antd`, icons, fonts, i18n) are its peer dependencies and root dependencies of the apps. **`NexProvider`** (the root of all three apps) = `LanguageProvider`
(D-087) + AntD `ConfigProvider` with the theme of the current language + AntD `App` (so `message`, `notification` and
`modal` follow theme and direction). **Components** (shared-ui): `PageHeader`, `StatusTag` (tone + icon + text, never
colour alone) and `PriorityTag` (new shared-types `PRIORITIES` = LOW|MEDIUM|HIGH|URGENT, labels `enums.priority.*`),
`EmptyState`, `ErrorState` (`errors.<CODE>`, the D-076 request id shown left-to-right for support, retry),
`LoadingSkeleton` (announced as loading; the skeleton itself is hidden from screen readers), `Ltr`/`Bdi`,
`DirectionalIcon` (mirrored in RTL from the AntD direction), `ConfirmModal` (controlled, translated buttons, `danger`) and
`AiDisclaimer`; their texts are `common.*` keys. Case/task status tags come with those features. **Storybook 10**
(`@storybook/react-vite`, Nx plugin targets `storybook`/`build-storybook`) with a Language toolbar (Arabic RTL / English
LTR, every story wrapped in `NexProvider`) and the a11y addon (violations fail the story). Storybook telemetry is off (D-077); `storybook dev` is a local tool only and `storybook-static` is never deployed.
**Deviation from the ticket:**
instead of the browser-based Storybook test-runner, `src/stories.test.tsx` turns every story into a Vitest test, rendered in
both languages and checked with axe-core in jsdom (colour contrast is left to the Storybook a11y panel, as jsdom has no
layout) — no Playwright browsers in CI. The test composes stories with the real `.storybook/preview.tsx` (its decorator and toolbar) and fails when an
exported component has no story. Stories hold sample data and are excluded from `i18next/no-literal-string`.
`PageHeader` renders the page's `<h1>` (size of heading 3). The AI disclaimer says the output may be wrong, is not legal
advice and must be verified by a lawyer (D-057) — wording to be confirmed by the owner.
Why: a consistent, accessible, RTL-correct base for three apps, with checks that run in the normal test target.

**D-089 — Shared API client details** · Accepted (MVP-36, 2026-10-05)
MVP-36 left error mapping, refresh failure handling and the response checks open. → `createApiClient({ baseURL, realm,
getToken, setToken, onAuthFailure })` in `shared-api-client` (axios, 30 s timeout, `withCredentials`, `X-Requested-With:
XMLHttpRequest` on every request because the cookie endpoints require it, D-055; `allowAbsoluteUrls: false`, so a `path`
can never send the bearer token to another host). `request(req, schema)` unwraps the envelope and **parses `data` with
the contract's response schema** (a mismatch is `ApiError` SYS-001 whose message names paths and issue codes, never
values); `request(req)` without a schema is for 204/acknowledgement endpoints. Every failure is an `ApiError{code,
message, details, status, requestId}`: the server's envelope as sent; an unknown code → SYS-001 (like `ErrorState`);
no response (offline, timeout) → **SYS-002 with status 0**; a non-envelope answer (proxy/CDN page) → SYS-002 for
502–504, else SYS-001; cancellations pass through untouched for TanStack Query (never log them: the axios error carries
the request headers). **Refresh:** only a 401 `AUTH-002` refreshes (AUTH-003 and the rest pass through): one refresh per
tab, concurrent requests join it, each request is retried once (a second AUTH-002 goes to the caller); a request sent with
a token another refresh has already replaced just retries, and one whose session ended meanwhile fails as it is.
Refreshes are **serialised across tabs with the Web Locks API** (`nlq-refresh-<realm>`), which D-082 requires (two tabs
rotating the same cookie would look like reuse and end the session); a tab that waited for the lock rotates once more,
which is harmless. **Login, register and logout** go through `sessionRequest`: after any refresh of the tab and under the
same lock, never refreshed — otherwise a logout racing a rotation in another tab would revoke nothing and leave a live
cookie behind, or a rotation could overwrite a fresh login's cookie. Only a **refusal** (401, or 403 AUTH-006/010) clears the
token; offline, a 5xx or a 403 AUTH-100 (CSRF misconfiguration; the server keeps the cookie) keep the session so the user
can retry. `onAuthFailure` fires once, and only when a request lost its session mid-use: restoring the session at app start
(`authApi.refresh`) just rejects, so public pages (reset-password and verify-email links) are not sent to sign-in. Realm
refresh paths `portal/auth/refresh` and `admin/auth/refresh` are **provisional** until those realms exist (their cookie
paths must match). The access token is only held through `getToken`/`setToken` (D-050): sessions returned to the app
(`ClientSession`) leave it out, and a test fails if the package touches web storage or cookies. **Resources:**
`authApi(client)` (register, login, refresh, logout, verify-email, resend-verification, forgot/reset-password; logout clears
the token even offline) and `usersApi(client)` (`changePassword`; `users/me` and team endpoints join with their backend
story). `idempotencyHeaders(key)` takes the key the caller created once per user action (`crypto.randomUUID()`, which
needs a secure context) and reuses on retries. **Deployment:** the SPAs and the API must be on the same site (subdomains of
one registrable domain), or the `SameSite=Lax` refresh cookie is not sent. Tests use MSW 3 (Node; vitest's optional
`msw ^2` peer is unused); axios is `^1.20` (1.20 fixes high-severity advisories in 1.13–1.19). Server packages are banned in `layer:api-client` like in the UI layers.
Why: the three SPAs handle sessions, errors and contracts identically, and a session survives a flaky network.

**D-090 — Office-app sign-in, session and idle timeout** · Accepted (MVP-42, 2026-10-06)
MVP-42 left the session plumbing, the idle-timeout source and the E2E journey open. → **Libraries:** TanStack Query 5 and
Zustand 5 (the stack architecture.md lists) join as root dependencies. **Session** (`apps/office-app/src/features/auth`): a
Zustand store `{status: loading|authenticated|anonymous, user, accessToken, idleMinutes, signOutReason}` in memory only
(D-050; the API client reads the token from it, React Query never sees it). `restoreSession()` runs once per page load from
`main.tsx` (not an effect, which StrictMode runs twice); guards show a loading state until it answers. `RequireAuth` sends an
anonymous visitor to `/login?next=<path>&reason=<why>` and `GuestOnly` sends a signed-in one on; **`next` must be a same-app
path** (`/…`, not `//…`, `/\…` or a URL), or it is ignored — no open redirect. `RequirePermission` shows the AUTH-100 message
(UI only, D-051). Signing out (button, idle timeout, a session lost mid-use via `onAuthFailure`) clears the store and
`queryClient.clear()`. **Other tabs** follow through a `BroadcastChannel('nlq-session')`: `signedOut` ends their session,
`signedIn` makes an anonymous tab restore its own (no token ever travels), `activity` feeds the idle timer. **Idle timeout:**
default **30 min** (D-053) until the office setting is readable (office settings API, MVP-48 sets `idleMinutes`); a warning
modal with a countdown during the last minute ("stay signed in" / "sign out"); counted from the last pointer, key, wheel,
touch or mouse activity in any tab, by timestamps (a sleeping laptop is judged correctly); it then signs out on the server
and shows "signed out after inactivity". **Pages** (lazy routes): `/login` (remember me, AR | EN switch, forgot link,
notices for idle/expired/signed-out/password-reset), `/signup` (register contract; defaults PALESTINE, ILS, FIRM, office
language = current UI language; Terms/Privacy links to `/legal/terms|privacy`, which the app must still serve, D-085),
`/forgot-password` (same answer for every email), `/reset-password` and `/verify-email` (work signed in or not). The link
token is read once and **removed from the address bar**, and `index.html` sets `<meta name="referrer" content="no-referrer">`
(D-086); the verify call is sent once per page (single-use link). A used/expired link (410 RES-004) offers a new one; a
verified signed-in user is updated in place. **Forms:** AntD `Form noValidate` (the browser's own validation would block
the submit with an untranslated popup) + `zodRule(fieldSchema)` = a `required` rule when the contract rejects "empty" and a
validator with the contract's `validation.*` message, then the whole contract on submit (cross-field rules); API `VAL-001`
details go on their fields, every other error is `errors.<CODE>` in a banner (AUTH-001, 423 AUTH-007, 429 RATE-001…; the
`Retry-After` seconds are not shown, `ApiError` carries no headers). **Tests:** Vitest + MSW 3 flows, both languages, axe on
the login and signup pages (colour contrast and landmarks excluded, as in D-088); `src/test/setup.ts` stubs `matchMedia` for
AntD's grid. **Deviations:** the Cypress login journey moves to the E2E story (MVP-115), which creates the Cypress project;
every interactive element has a `data-testid` for it. The signed-in home is a placeholder with a sign-out button, and the
"confirm your email" banner comes with the app shell (MVP-45). Why: one session model for every page and tab, no token
outside memory, and sign-in errors explained in the user's language.
Review additions (same PR): **Start-up** distinguishes a refusal (401, AUTH-006/010 → signed out) from an unreachable API
(offline, 5xx, 429 → `status: error`, protected pages show `ErrorState` with a retry; the cookie may be valid). **Idle across
page loads:** the last activity time (`nlq.lastActivity`, a timestamp, not secret) is kept in localStorage while signed in and
removed at sign-out; a restore older than the idle timeout signs out (server revoke) with the inactivity notice instead of
resuming — closing the tab no longer resets the timer on a shared computer. While the warning is open only its buttons count
(moving towards "sign out" no longer closes it), and the countdown is not a live region. **Tabs:** `signedOut` carries its
reason; messages are shape-checked and an activity time is capped at "now" (a forged or future time cannot switch the
timeout off); `signedIn` makes every tab re-check its session, and a different user in the cookie clears the previous user's
cache first. A **password reset while signed in** ends this tab's session and the others' (D-086 already revoked them on the
server). **Verify-email:** a failure other than 410 (offline, 5xx, 429) offers "try again" with the token kept in memory —
the address bar no longer has it — and the signed-in session is not patched (the link may be another account's). **`next`**
is parsed with `URL` against the app origin and refused with control characters (`/%09/evil.test`). **Signup:** after a 5xx
or RES-002 the banner offers sign-in (D-083: the office may exist), the office language follows the AR | EN switch until
picked, and currencies show their localized name with the code isolated. **Retry-After:** `ApiError.retryAfter` (seconds,
amends D-089) and the API's CORS `exposedHeaders` now include `Retry-After`, so the banner says how long to wait (plural
forms in Arabic). Login, signup and reset mutations use `gcTime: 0` (no password left in the mutation cache); password
inputs are `dir="ltr"` (the policy is Latin letters and digits); a production build fails without an `https://`
`VITE_API_URL`. **Open, owner's call:** enforcing the idle timeout on the server too (refuse a refresh after inactivity),
or a browser-session cookie when "remember me" is off — both change D-082.

**D-091 — Office-app shell, menu permissions and responsive navigation** · Accepted (MVP-45, 2026-10-06)
MVP-45 named the menu items but not the permission behind each, nor how the breakpoints and placeholder pages work. →
**Layout** (`apps/office-app/src/features/shell`): AntD `Layout` inside `RequireAuth`; header = product name (text until a logo
is hosted) + office name, search button (Ctrl/Cmd+K by the physical `KeyK`, so it works on an Arabic layout; a placeholder
overlay until search is built), quick actions, notification bell slot (empty state), account menu (profile, language,
sign-out; the language applies at once and is saved to the profile once `PATCH users/me` exists). AntD lays the side menu
out in the reading direction, so it sits on the right in Arabic with no extra code. **Menu permissions** (`nav.tsx`, the
same permission guards the page): Dashboard, My cases, Calendar, Tasks, Documents → `view:assigned:cases` (every role);
Clients → `manage:clients` (not TRAINEE or EXTERNAL_COLLABORATOR, who have no client permission); Reports → `view:reports`
(OM/SL/A); Team → `manage:users` (OM); Settings → `manage:office` (OM). **Quick actions:** + Case (`create:case`), + Client
(`manage:clients`), + Task (`create:task`), each a "coming soon" placeholder; the button is hidden for a role that can
create none (TRAINEE, EXTERNAL_COLLABORATOR). frontend.md's "AI Ask" quick action waits for the AI features.
**Breakpoints** (`Grid.useBreakpoint`): ≥1200 px full side menu with a collapse control; 768–1199 px icon-only, not
expandable; <768 px no side menu, a bottom bar (Home, My cases, Calendar, Tasks, Menu → the whole menu in a bottom drawer)
whose items share the width so five fit at 360 px. **Routes:** every menu item has a lazy placeholder page until its feature
replaces it; a page behind a permission shows a **403 page** (`RequirePermission` moved from auth to shell), an unknown
address the **404 page** inside the shell, a route whose code fails to load (stale chunk after a deploy, offline) a
"reload" page (`errorElement`), and the first lazy load a skeleton (`HydrateFallback`); later navigations show the skeleton
in the content area. The **email-confirmation banner** (D-083) sits under the header while unverified, with the deadline in
the user's language and "send the link again". **Translations:** a `shell` namespace. **Tests:** the menu of all seven roles,
the three breakpoints (a `matchMedia` stub answers width queries from `window.innerWidth`; `ResizeObserver` stubbed for
AntD's Menu), Ctrl/Cmd+K, quick actions, 403/404, banner and sign-out, axe in both languages; the ticket's "RTL snapshot" is
asserted on direction classes and DOM order instead (AntD's generated class hashes make snapshots churn). Checked in a
browser at 1366, 1000 and 360 px in Arabic and English. Why: one layout for every office page, with navigation that only
offers what the role may open.
Review additions (same PR): the **routes are generated from `NAV_ITEMS`**, so a page always requires its menu item's
permission (no second list to drift); the **403 page is a courtesy**, the API re-checks every call (D-051), and a route
**loader** added later must check the permission itself (loaders run before `RequirePermission` renders). Menu and
bottom-bar entries are **links** (open in a new tab, announced as links); the collapse control is a named button
(`aria-expanded`); the sign-out and collapse icons mirror in Arabic. The skeleton shows only when moving to another page (a
page refreshing its own data stays mounted). Page errors render **inside the shell** (`errorElement` on the shell's pages):
a thrown 404 is the 404 page, a failed code chunk offers a reload, anything else the generic error with a retry — never the
error's text. The placeholder pages are their own chunk. The shortcut ignores Shift, Alt/AltGr, auto-repeat and IME
composition, and shows ⌘K on Apple devices. The confirmation banner is one sentence per language with the deadline in the
user's time zone and Western digits (`<locale>-u-nu-latn`), and a failed "send again" says why. The quick-action "+ File"
of the ticket is "+ Case" / "ملف جديد", the glossary's UI terms for `LegalFile`. **Known gaps:** there is no `view:clients`
permission, so `manage:clients` doubles as "see clients" — the Clients feature decides whether the matrix needs one; the
menu follows the permissions of the last sign-in or refresh (up to 15 min stale after a role change; the server applies it at
once, D-081). **Open, owner's call:** Arabic month names — today the MSA names (أكتوبر) as dayjs `ar` prints them; the
Levantine names used in Palestine (تشرين الأول) would apply to every date in the app.
