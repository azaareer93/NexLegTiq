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

**D-092 — Formatting dates, numbers and money; Arabic normalisation** · Accepted (owner chose MSA month names; MVP-46, 2026-10-06)
MVP-46 left the month names, rounding, time zone and digit preference open. → **`shared-utils`** (pure, **100% coverage
enforced**): `formatDate(value, {locale, timeZone, digits, style})` writes **dd/MM/yyyy** in both languages whatever the
locale's own pattern (`style: 'long'`: 13 أكتوبر 2026 / 13 October 2026 — English in day-month order); `formatTime`
(3:05 م / 3:05 PM), `formatDateTime`, `formatRelative`, `formatNumber`, `formatMoney(amount: decimal string, currency,
options)`. The ticket's positional `(date, locale, tz)` became one **options object** (`locale` required, `timeZone` and
`digits` optional), so a new option never reorders arguments. **Arabic month names are MSA everywhere** (أكتوبر, not the
Levantine تشرين الأول — owner's choice): the Intl locale is plain `ar`. **Digits** are Western by default and Arabic-Indic
(٠-٩) as a user preference; the numbering system is always explicit (`<locale>-u-nu-latn|arab`), because engines disagree on
Arabic's default. **Time zone:** every instant is shown in an IANA zone, never the device's — the user's `timezone`, else
the office's, defaulting to `Asia/Hebron` (`Office.timezone` default; a caller that passes none gets it, deliberately). DST
is ICU's (Hebron 2026: 28 March and 24 October, tested). A **date-only string** (`YYYY-MM-DD`, a deadline) is a calendar
date and shown as written in every zone; a date and time without a zone is refused (each machine would read it differently). **Relative time** counts **calendar days in the user's zone** (a hearing at 05:00
the day after tomorrow, seen at 17:00, is "بعد الغد", never "tomorrow" because it is 36 h away): minutes/hours within the same
day, days up to 13, then weeks, months, years; Intl gives أمس، أول أمس، غدًا and Arabic's dual and plurals. **Money:**
amounts stay decimal strings end to end (D-017) and are parsed **strictly** (`-?digits[.digits]`, up to 30+20 digits):
exponents (`1e200000000` would freeze the page when written out), hex/binary/octal (`0x10`), `NaN`, `Infinity` and stray
spaces are a `RangeError`, as is an unknown currency code. `formatMoney` rounds **half-even with decimal.js to the currency's
own minor digits** (ILS 2, JOD 3, JPY 0) before Intl lays it out (symbol and position, grouping, digits: ₪1,234.50, and in
Arabic the amount then ₪ with a no-break space and Intl's bidi marks); it never shows "-0.00" (`signDisplay: 'negative'`).
Rounding before Intl also keeps older engines without ES2023 Intl (Firefox 115 ESR) correct. **Money math** (`parseAmount`,
`addMoney`, `subtractMoney`, `multiplyMoney`, `percentOf`, `roundMoney(value, digits | currency)`, `compareMoney`) runs on a
private decimal.js clone (precision 40, half-even); results are unrounded until `roundMoney`, so a total is rounded once;
a property test checks `roundMoney` against an integer (BigInt) half-even implementation on 2,000 amounts per precision (0–3 decimals, a quarter of them exact ties) plus sum/round invariants. Intl
formatters are built once per locale/zone/currency and reused (≈0.3 ms each to build). `toWesternDigits` reads what a user
typed (Arabic-Indic and Persian digits, ٫ as the decimal point, ٬ dropped). `normalizeArabic` mirrors `nlq_normalize_ar`
(tashkeel, dagger alef, tatweel, alef/ya/ta-marbuta/hamza forms, lower-case); the Postgres integration test asserts both give
the same result on the same fixtures. **Bidi:** formatter output is plain text. In running text, money and long dates are
already in the reading direction — `<Bdi>` at most, **never `<Ltr>`** (it would put ₪ on the wrong side and read an Arabic
date backwards); `<Ltr>` is for file numbers, phones, emails and a short date next to Latin text. In plain-text contexts
(subjects, titles, `aria-label`s) `isolateLtr`/`isolate` add Unicode isolates and strip any bidi controls inside, so the text
cannot break out (Trojan Source style). **No file-number helper:** numbers are generated by the server (D-031) and only
displayed, in `<Ltr>`/`isolateLtr`. **`shared-ui`:** `useFormat()` returns the formatters bound to the current language and
to the `timeZone`/`digits` given to `NexProvider` (an unknown zone falls back to Asia/Hebron instead of breaking every
page); the office app passes none yet (no user or office setting in the session until the profile and office settings
exist). **Dependencies:** decimal.js 10 at the root and in `shared-utils` (D-074); the backend uses `shared-utils` only in a
test. ES2023 Intl options are typed locally (the workspace compiles with the `es2022` lib). **Known limits:** money columns
are `Decimal(14,2)` (D-017) while JOD has three minor digits — the billing schema must decide before JOD fees are stored;
search does not fold Arabic-Indic digits, presentation forms from PDFs/OCR (NFKC) or Persian ک/ی — that needs the same change
in `nlq_normalize_ar` (a migration) and belongs to the Arabic search story. Why: one way to show legal deadlines and fees,
never off by a day or a fils.

**D-093 — Shared error feedback and the session-expired flow** · Accepted (MVP-120, 2026-10-06)
MVP-120 asked for `useApiErrorHandler`, error pages, an offline banner, a session-expired modal and toast conventions; much of it
already existed (route error boundaries and 403/404 pages, D-091; `ErrorState`/`LoadingSkeleton`, D-088; the AR/EN check of every
error code, D-087). → **shared-ui** gets the error helpers, so the portal and admin panel reuse them: `useApiErrorHandler()` →
`messageOf(error)` (`errors.<CODE>` plus how long to wait from `Retry-After`; anything else, including an unknown code or a plain
`Error`, is the generic message — never the error's own text), `referenceOf(error)`, `translateKey(key)` (contract/API
`validation.*` keys), `applyToForm(form, error, fields)` (VAL-001 `details` onto fields; true when they explain everything) and
`notify(error)` (AntD notification, needs `NexProvider`'s `App`); `ApiErrorAlert` replaces office-app's `FormError`. shared-ui may
not import shared-api-client (Nx boundaries), so errors are matched **structurally** (`ApiErrorLike`: a `code` shaped `ABC-123`,
optional `details`, `requestId`, `retryAfter`; axios codes such as `ERR_NETWORK` never match). **Support reference:** the D-076 request
id is shown only when the user cannot fix the failure (`SYS-`, `DB-`, `EXT-`, `STO-` or a code this build does not know) — not under
"wrong password". **Offline:** `OfflineBanner` reads `navigator.onLine` and its events (reliable for "offline", optimistic for
"online"), shown under the shell header and on the sign-in pages; requests still fail as SYS-002 and keep their own messages.
**500 page:** an unexpected route error is AntD's `Result status="500"` with "try again" (reload) and "home". **Deviation:**
the ticket's "illustrations original" is not met — the 403/404/500 pages use AntD's own MIT-licensed illustrations until custom
artwork exists (owner's call). **Deviation — no session-expired modal:** when a refresh is refused the session is already gone
(token, user and query cache cleared, D-090), so a modal could only add a click before the same redirect; the guard sends the user to
sign-in with the "session expired" notice and `next` set to where they were, which meets the ticket's intent. **Toast conventions**
live in Storybook (Feedback › API errors › Feedback conventions): success → `message.success` (new key `common.feedback.saved`); failed
action → `notify`; failed form → fields + `ApiErrorAlert`; failed load → `ErrorState`. `auth.retryAfter_*` moved to
`common.states.retryAfter_*`. Review additions (same PR): **the API client keeps a request id only when it has the D-076 shape**
(`ApiError` drops anything else — a proxy's header could otherwise put arbitrary text or bidi controls next to "Reference") and
caps `Retry-After` at a day; `AI-001`/`AI-004` (provider down or failing) also show the reference; `ApiErrorLike.code` is a plain
string and "known" means `isErrorCode` (shared-types), whose AR/EN text D-087 guarantees; the handler is memoised (stable until the
language changes, so it can be an effect dependency) and `notify` falls back to AntD's static notification outside `App`; a route
whose loader throws an `ApiError` shows `ErrorState` with its message and reference instead of the bare 500 page; `OfflineBanner` /
`useOnline` live in their own component folder; the 500 text no longer claims the problem "has been recorded" (there is no
client-side error reporting yet). Why: every app explains failures the same way, in the user's language, with a reference support
can use.

**D-094 — Code quality tooling: rules, formatting and git hooks** · Accepted (owner chose our hook installer over husky and
printWidth 100; MVP-29, 2026-10-07)
→ **ESLint:** the rule set of quality-testing.md lives in `packages/shared-config/eslint/base.mjs`; the root
`eslint.config.mjs` re-exports it and every project spreads it (apps and shared-ui add `no-literal-string`, D-087; the backend adds
`backend-rules.mjs`). Type-aware rules use typescript-eslint's **project service** (each file checked with the tsconfig that
includes it). `no-unsafe-*` are **off in tests** (Supertest bodies and mocks are `any`; ≈180 hits, none a real risk) while
`no-floating-promises` stays on there; `max-lines` is off in tests; `no-console` is off in `scripts/` (CLIs). Rest siblings and
`_`-prefixed names may be unused. Physical properties in an inline `style` (`marginLeft`, `right`…) are an error. **Custom bans**
(fixtures in `shared-config/src/lint-rules.spec.ts`): `$queryRawUnsafe`/`$executeRawUnsafe`; `nexlegtiq/no-raw-cache-key` — a
string, template or concatenated key passed to a Redis/cache client method (`get`, `set`, `del`, …; receiver named `*redis*` or
`*cache*`) outside `CacheKeys` (a heuristic: a key held in a variable is not seen); `nexlegtiq/unscoped-needs-reason` moved here
from the backend config. Everything is an error and `nx lint` runs with `--max-warnings=0` (`targetDefaults.lint`). Five
functions over complexity 10 were split, not suppressed (the env production checks became a table; the raw-SQL tenant guard moved
to `tenant-raw-sql.ts`, behaviour unchanged). **Prettier** as specified (printWidth 100): the whole repository was reformatted in
one mechanical commit; `*.md` (hand-wrapped prose, tables) and `*.sql` (migrations reviewed as written) are not formatted, nor
tool-owned files. As PRs are squash-merged (D-070), the squash commit of the MVP-29 PR is added to `.git-blame-ignore-revs` after
the merge. **Stylelint:** logical properties only (`property-disallowed-list`, and `left`/`right` values of `text-align`, `float`,
`clear`). **Git hooks — deviation from the ticket's husky:** husky works by setting `core.hooksPath`, which would silently disable
graphify's hooks and our post-merge hook in `.git/hooks`; instead `scripts/git-hooks/` gains `pre-commit` (lint-staged: Prettier +
ESLint with each file's own project config, or stylelint), `commit-msg` (commitlint: conventional, `Refs: MVP-n`, header ≤ 100,
subject case free so `docs: D-094 …` passes) and `pre-push` (`nx affected -t typecheck test --base=origin/develop`), installed by
the existing installer, now also run on `pnpm install` (`prepare`; skipped in CI and outside a git clone). CI runs
`pnpm format:check` and `pnpm lint:css`. Review additions (same PR): **commit messages must carry `Refs: MVP-<n>`**
(`references-empty`); lint-staged runs ESLint `--fix` before Prettier, so its fixes are formatted; **pre-push** compares with the
merge-base of `origin/develop` and skips with a note when that ref is unknown (no blocked push before a `git fetch`); root
`scripts/` and `*.config.mjs` belong to no Nx project and are linted by `pnpm lint:root` in CI; `unscoped-needs-reason` also
catches ``prisma[`unscoped`]`` and any run-time key on the Prisma service (`prisma[k]`); `no-raw-cache-key` also catches computed
commands (`redis['get']`), every key of `del`/`unlink`/`exists`/`mget` and more commands; the inline-style ban also covers quoted
keys and `textAlign`/`float`/`clear: 'left'|'right'`; every fixture asserts the code parsed. The test rules (`no-unsafe-*` off,
no `max-lines`) apply to `*.spec.*`, `*.test.*`, `*.stories.tsx` and `test/` helper folders. **Known limit:** an inline
`eslint-disable` can still silence the security rules; reviews grep for it (a lint ban on such comments needs another plugin).
Why: the quality gates are enforced by the machine, not by review, without breaking the local knowledge hooks.

**D-095 — Legal-file schema and file numbering** · Accepted (owner chose the four calls below; MVP-56, 2026-10-08)
MVP-56 lists ten models, but FileClient needs Client (MVP-53), LegalFile's court and judge need Court/Judge (MVP-66), and D-031
(one counter per office + year) and domain-model.md (per office + year + type) disagree. → **Client is created here** (all
domain-model columns, soft delete, `(office_id, display_name)` index); ContactPerson, search indexes and the API stay in MVP-53.
**`courtId`/`judgeId` are added by MVP-66** with their tables (nullable columns + composite FKs, nothing to backfill); the
Phase 2 `embedding vector(1536)` waits for the similar-cases story. **Numbering (amends D-031):** the counter follows the
office's format — per office + year + type code when it shows `{TYPE}`, one shared counter when it does not (`type_code` '',
and `year` 0 without `{YEAR}`), so a rendered number can never repeat. `FileNumberService.next(tx, fileType, year)` runs in
the file's create transaction: `createMany … skipDuplicates` (ON CONFLICT DO NOTHING) makes the counter row once, then an
`UPDATE … last_value + 1` takes its row lock until commit (the ticket's `SELECT … FOR UPDATE` cannot lock a row that does not
exist yet, so two first creates would race) — concurrent creates queue, a rollback gives the number back, numbers are
gap-free; 50 parallel creates are tested. A number is never reused, also after a soft delete. Formats: `{YEAR}`, `{TYPE}`,
`{SEQ}`/`{SEQ:n}` (n 1–9, zero-padded, grows past its width), exactly one `{SEQ}`, literal text limited to letters, digits,
space and `. _ / # -` (no bidi controls or markup — numbers are shown in `<Ltr>`); `parseFileNumberFormat` is what the
settings API (MVP-48) validates with. Type codes in `file-number.ts` (LIT, CRM, CON, ADV, CMP, CRS, BUS, NDA, WIL, INC, RNT,
EMP). **Schema details:** every reference between tenant rows is a composite `(…_id, office_id)` FK (D-079), so a file can
never name another office's client, party or user; optional ones are `RESTRICT` (SetNull would also null `office_id`). Join and
history rows (FileClient, FileTeamMember, FileParty, ConflictOfInterest, CaseTimelineEvent) cascade with a hard-deleted file
(files are soft-deleted; the cascade only serves purges); notes block it. One primary client per file (partial unique index);
CHECKs: closing ≥ opening date, rates not negative, a party has its name (person → full name, organisation → company name), a
conflict names two different files, a note belongs to a file or a client. Indexes: list `(office_id, updated_at DESC) INCLUDE
(number, title, type, status, priority, lawyer) WHERE deleted_at IS NULL`, open files per responsible lawyer (partial), the
assigned scope's lawyer/paralegal/team-member columns, conflict lookup by party; MVP-57 checks them with EXPLAIN on 5k files.
`openingDate`/`closingDate` are dates (`@db.Date`). `TaskTemplate.defaultAssigneeRole` is a **file team role**
(RESPONSIBLE_LAWYER|PARALEGAL|MEMBER, null = responsible lawyer), not an office role. CaseTimelineEvent is append-only by
convention (no `updatedAt`). Party national id/notes, client national id and confidential note bodies are ciphertext columns;
the field encryption itself (D-056) arrives with the first story that writes them. shared-types gains `FILE_TYPES`,
`FILE_STATUSES`, `CLIENT_TYPES`, `FILE_TEAM_ROLES`, `PARTY_TYPES` with AR/EN labels (`CONFLICT_RESOLUTION` reads "Dispute
resolution" / تسوية النزاعات, to keep it apart from conflict of interest). Why: the core tables land once with their
integrity in the database, without inventing court or client APIs ahead of their stories.
Review additions (same PR): the service is `next(tx, fileType, year)` — the office comes from CLS, never a parameter;
`year` is the opening date's year in the office's time zone (D-092) and must have four digits. **A number a file already
has is skipped** (a format change that renders an existing number, a soft-deleted file), so one clash can never block
numbering; existing numbers are never rewritten when the format changes. Formats are at most 64 characters and literal
digits are Western only (search does not fold Arabic-Indic, D-092). A missing OfficeSettings row is a plain error (500, not
the 404 P2025 would map to). **Composite FKs are `ON UPDATE RESTRICT`**: with Prisma's default cascade, re-keying a user's
`office_id` through the raw client carried their files, notes and timeline into the other office (reproduced in review);
the init migration's older composite user FKs still cascade — a later migration should align them. **Encrypted columns are
enforced by CHECK** to hold the key-version prefixed ciphertext (`v<n>:…`, ops-security.md) — client and party national
ids, party notes, the tax id of an individual client or party (D-056 covers tax ids of individuals) and confidential note
bodies — so plaintext can never be written before the field cipher exists, nor read through the read-only role. One
responsible lawyer per file (partial unique index; MVP-57/61 keep `responsibleLawyerId` in sync with it), one conflict row
per (file A, file B, party) so detection can upsert, conflicts indexed by party, `due_days_after_open >= 0`,
`FileClient.updatedAt`. `case_timeline_events` loses UPDATE for the app role (migration and `db-roles.sql`, like the
audit log; DELETE stays for purges). Left to their stories: who created a file is the `FILE_OPENED` event's actor (no
`createdById`); FTS on file title/number (MVP-57) and trigram indexes for party and client names (MVP-62, MVP-53); `Party`,
`FileNote` and `TaskTemplate` have no soft delete (`TaskTemplate.isActive` retires a template); `fileNumber` is never taken
from client input. Labels: `CRIMINAL` is "قضية جزائية" (a noun, not the bare adjective), `SUSPENDED` "معلّق" (موقوف also
reads "detained"), `WILL_TRUST` "وصايا وأوقاف".

**D-096 — Legal files API: access, confidentiality and what waits for other stories** · Accepted (MVP-57, 2026-10-08)
MVP-57 assumed sessions, documents, tasks, courts and a cache existed, and left confidentiality and the paralegal/lawyer
rules open. → `POST/GET /cases`, `GET/PATCH/DELETE /cases/:id` (`src/modules/legal-files`, contracts in
`shared-contracts/case.contract.ts`). **Access** (`CaseAccessService`, exported for other features' routes on a file):
lists use `visibleWhere()`, every route on a file `assertFileAccess(id, 'read'|'write')` — not visible, not assigned (for
`edit:assigned:case` only) or another office → 404 RES-001 (D-019, a malformed id too); writing to an ARCHIVED file →
422 BIZ-007 (PATCH and DELETE; reads still work). **Confidential files** are visible only to the OFFICE_MANAGER and the
people assigned to them, also for SENIOR_LAWYER and ADMIN who otherwise see every file (`caseScopeWhere(scope, role)`).
`scope=mine` narrows to assigned files whatever the permission. Routes: create `create:case`; list/get ANY of
`view:all|assigned:cases`; PATCH ANY of `edit:any|assigned:case`; DELETE `delete:case` (soft: `deletedAt`, gone from
lists, number kept, D-095). **Create** runs in one transaction: participant checks, number (D-095, the year of the opening
date in the office's time zone — 23:30 UTC on 31 Dec is already next year in Hebron), the file, FileClient rows (one
primary, which must be in `clientIds`), FileTeamMember rows (the responsible lawyer as RESPONSIBLE_LAWYER, the paralegal
as PARALEGAL), the FILE_OPENED timeline event (actor = creator, payload `{fileNumber}`) and a CREATE audit row. Clients
must be live (`deletedAt` null, active) clients of the office; the responsible lawyer an active OFFICE_MANAGER,
SENIOR_LAWYER or LAWYER; the paralegal an active PARALEGAL — otherwise 400 VAL-001 on the field
(`validation.unknownClient|responsibleLawyer|responsibleParalegal`). The office supplies currency, jurisdiction and opening
date (today); `billingMethod` defaults to the office's, and an hourly file without a rate gets the office's default rate.
Money is a decimal string with at most 2 decimals (`MoneySchema`, `validation.amount`). **PATCH** edits title,
description, sub-type, priority, billing fields, court case number and confidentiality (`null` clears); number, type,
status, lawyer and team have their own routes (close/reopen/archive/reassign, team) — unknown fields are dropped, an empty
change is VAL-001; an UPDATE audit row holds the old and new values of the changed fields. **List**: filters `status`,
`fileType`, `priority`, `clientId`, `responsibleLawyerId`; `search` matches number, title, court case number and client
names (case-insensitive `contains`; Arabic-normalised full-text search comes with global search); `sort=field:dir,…` over
`updatedAt|createdAt|openingDate|fileNumber|title|priority|status` (default `updatedAt:desc`, id as tie-breaker); page/limit
≤ 100. Rows: number, title, type, status, priority, opening date (`YYYY-MM-DD`), confidential flag, primary client,
responsible lawyer, `updatedAt`. Detail adds the remaining columns, clients, team and counts of parties and notes.
`BILLING_METHODS` joins shared-types with AR/EN labels. **Performance:** with 5k files the list (as manager, as an
assigned-only lawyer, filtered, a deep page, a search) stays under 500 ms P95 through HTTP (`cases.performance.int.spec.ts`);
EXPLAIN shows the default and assigned lists on `legal_files_list_idx` (0.1 ms), the count a 1.3 ms scan.
**Deviations / later stories:** `courtId`/`judgeId` with the courts story (D-095); next hearing and document/task counts with
their tables; task templates applied by the Tasks epic; no `o:{officeId}:case:{id}` cache — a primary-key read is far
inside the budget and nothing caches yet, so the cache and its invalidation wait until a measurement asks for them; no
custom opening date at creation yet (importing older files). The HTTP half of the isolation matrix now runs
(`tenant-isolation.http.int.spec.ts`: list, get, update, delete → 404 for every matrix entry with endpoints).
Why: one access rule for every route on a file, and the case list the UI needs without inventing tables early.
Review additions (owner chose the confidentiality, billing and audit rules; same PR): **Confidentiality** is set or lifted
only by the OFFICE_MANAGER or the file's responsible lawyer (create and PATCH; others 403 AUTH-100) — a paralegal or a
senior lawyer cannot expose a confidential file. **Billing terms** (`billingMethod`, `hourlyRate`, `fixedFee`,
`retainerBalance`) are returned only to holders of `view:all|assigned:invoices` (TRAINEE and EXTERNAL_COLLABORATOR get
`null`) and written only with `generate:invoice` (a PARALEGAL sending them gets 403). **Audit:** an UPDATE row holds only
the fields whose value really changed (money compared as decimals, old money with 2 digits, `""` stored and audited as
null); a change that changes nothing writes nothing. Audit rows keep titles and descriptions in full — the audit-viewer
story must hide LegalFile rows the viewer cannot see (`visibleWhere`), since ADMIN holds `view:audit` but not confidential
files. **Writes are conditional** (`updateMany` on a live, non-archived file): a file deleted or archived between the
access check and the write is 404, so concurrent deletes never write two audit rows. DELETE is checked as a write (every
`delete:case` holder also has `edit:any:case`). A missing caller in the request context is 500 SYS-001, not 403. The
create answer is the file even when the creator is not assigned to it (a paralegal opening a file for a lawyer, who then
cannot open it again). PATCH does not re-apply the office's default rate when the billing method changes, and does not
clear a rate or fee that no longer applies — billing consistency belongs to the billing story. Client-name search skips
deleted clients; `search` rejects control/bidi characters; a sort field may appear once. Conflict-of-interest detection
on create comes with the parties story (BIZ-009).

**D-097 — Autopilot delivery loop and stacked PRs** · Accepted (owner asked for it; MVP-141, 2026-10-09)
The owner wants tickets to flow without starting each step, and not to wait for merges. → `/ticket` now ends with `/review`
(fixes applied), `/ship` and `/sync-notion decisions`; `--auto` runs it unattended. `/autopilot` loops: (1) fix own open PRs
(failing checks, conflicts, owner review comments, a merged parent); (2) pick the To Do ticket with the highest priority,
then the most not-Done issues it blocks, then the lowest slice, then rank — eligible when every blocker is Done or has an
open PR; (3) deliver it. **Stacking:** a ticket whose blocker is only in review branches from that PR's branch (≤ 3 deep;
parent kept in `git config branch.<b>.nlqParent`) and its PR targets that branch with "Stacked on #n". Because PRs are
squash-merged (D-070), after a parent merges the child is retargeted to `develop` and **`develop` is merged into it** —
never rebased or force-pushed. **Questions:** only expensive-to-reverse decisions (CLAUDE.md) stop a ticket — posted as one
Jira comment with options and a recommendation, label `needs-decision`, back to To Do; the owner answers and removes the
label. Everything else is decided and recorded as `D-###`. **Limits:** never merges, never reprioritises or closes issues,
waits at 6 open PRs; a stop file ends it. **Usage limits:** a session cannot resume itself after a hard limit, so
`scripts/autopilot.sh` runs `/autopilot --once` in a fresh headless session per iteration and retries every 15 min after a
failed run (also gives each ticket a clean context). Headless runs use the permission mode the owner starts them with — the
script sets none. Why: the backlog moves while the owner only reviews and merges, without unreviewed code reaching
`develop`. Same PR, owner's additions: **two tickets in parallel** (default) in separate git worktrees when they do not
collide (different areas, at most one touching `prisma/`, not blocking each other); the second numbers its decisions from
the first's + 5, so `D-###` may have gaps (they are ids). A **push notification** after each delivered or skipped ticket;
`/standup` opens with "Waiting for you" (questions with recommendations, PRs in merge order). On the first idle round of a
day the loop **grooms** the backlog: missing "Blocks" links and splitting stories over ~3 days, never priorities or slices.

**D-098 — Tasks API: access, assignment and what waits for other stories** · Accepted (MVP-76, 2026-10-10)
MVP-76 left who sees a task, who may move it, tasks without a file and the notification channel open. → **Schema** (`Task`,
tenant, `tasks`): `fileId?` (null = a **personal task**), title, description, `dueDate` as a calendar date (`@db.Date`,
D-092: a deadline), `priority`, `status` TODO|IN_PROGRESS|BLOCKED|DONE (`TASK_STATUSES`, labels `enums.taskStatus.*`),
`assignedToId` (required; defaults to the creator), `createdById`, `completedAt` (CHECK: set exactly while DONE), `sortOrder`
(≥ 0); composite `(…, office_id)` FKs to the file (cascade, files are soft-deleted) and users (restrict); indexes
`(office_id, assigned_to_id, status, due_date)` and `(office_id, file_id)`. Tasks are **hard-deleted** with an audit row.
Deferred to their stories: `sourceType/sourceId` (templates, AI next steps), `reminderSentAt` (task reminders), recurrence
(Phase 2), a search vector (Arabic search). **Access** (`TaskAccessService`): a file's task follows the file — visible when
`CaseAccessService.visibleWhere` sees the file (scope + confidentiality, D-096), changed only with write access to it (else
404), and **read-only once the file is archived (422 BIZ-007, status moves included)**; a personal task is seen and edited
only by its creator and assignee (not even by the office manager). **Routes:** list/get ANY of `view:all|assigned:cases`;
create, PATCH, DELETE and reorder `create:task` (giving the task to someone else, on create or PATCH, also needs `assign:task`); bulk-assign
`assign:task`; `PATCH :id/status` `complete:task` with `@PermissionConditionsCheckedByService` — an EXTERNAL_COLLABORATOR
moves only tasks assigned to them (403 AUTH-100), a TRAINEE any task they can see. Every status change uses
`complete:task` (moving a card is working on it). **Assignee** (create, PATCH, bulk): an active user of the office whose
role holds `complete:task` (so not ADMIN staff) and who sees the file **by their own scope**; otherwise 400 VAL-001 on
`assignedToId` (`validation.assignee`) — another office's user fails the same way. **Status:** DONE sets `completedAt` and,
for a file's task, adds `TASK_COMPLETED` to the timeline (`sourceType 'Task'`, payload `{title}`); leaving DONE clears it;
the update is guarded on the status read, so a concurrent move is 409 RES-003 instead of a second event. **Kanban:** a new
task goes last in the office's TODO column (max + 1; concurrent creates may tie, ties order by due date); `PATCH
/tasks/reorder {status, taskIds}` sets positions 0…n in the order sent — every task must be editable and in that column
(`validation.taskColumn`); status changes keep the position. **Bulk assign** is all or nothing (one unreachable task → 404,
nothing changed) and returns `{updated}` (tasks that changed hands). **Lists** order by position, due date (nulls last),
creation; `dueBefore` includes that day; `overdue=true` = not DONE and due before today in the office's time zone.
**Notification:** assigning a task to someone else writes an in-app `Notification` (`type task.assigned`, `titleKey
common.notifications.taskAssigned`, params `{taskId, title}`, no link) in the same transaction; WebSocket push and email
come with the notifications story (no `notification` queue consumer exists yet). The HTTP isolation matrix covers `tasks`.
Why: one access rule for a file and its tasks, and no task route that reaches a file its caller cannot.

**D-108 — Clients API, contact persons and the field cipher** · Accepted (MVP-53, 2026-10-10)
MVP-53 needed the D-056 field encryption (no story had built it), a rule for "exactly one primary contact", and left counts,
search and the open-file sort open. → **Field cipher** (`src/common/crypto/field-cipher.ts`, global via `CoreModule`):
AES-256-GCM with a fresh 96-bit IV, stored as `v1:<base64url(iv | tag | ciphertext)>` (the `v<n>:` CHECKs of D-095), the
column, office and row bound as additional data (`clients.national_id:<officeId>:<clientId>`), so a value copied to another
column, office or row fails instead of decrypting (a new client is inserted first and its ids sealed in the same transaction,
since the row id is generated on insert); parties and confidential notes use the same pattern. Key: **`ENCRYPTION_KEY`** (ops-security.md), required, 64 hex characters; the dev/CI value (one
repeated digit) is refused in production. One key version for now — rotation adds older keys by version and a re-encrypt job
when first needed. **Losing the key loses the fields:** it belongs in the secret store with a backup. **Clients:**
`POST/GET /clients`, `GET/PATCH/DELETE /clients/:id`, all `manage:clients` (D-091's known gap stands: it also means "see
clients"). `nationalId` **and `taxId` are always encrypted** (D-056 asks it for individuals only; one rule avoids re-encrypting
when `clientType` changes) and returned decrypted only by `GET /clients/:id` (and create/update answers); audit rows record
`"[encrypted]"` instead of their values; a DELETE row keeps the client's `displayName`. PATCH writes and audits only changed fields (old and new); a primary lawyer must be an
active OFFICE_MANAGER/SENIOR_LAWYER/LAWYER (`validation.primaryLawyer`). **Delete** is soft (`deletedAt`; gone from lists and
lookups, 404 afterwards) and refused with **422 BIZ-010** (new code: "client has open files") while the client is linked to a
live OPEN or SUSPENDED file; CLOSED/ARCHIVED files keep pointing at it. **File counts** (`openFiles` in rows, `openFiles` +
`closedFiles` in the detail) count every live file of the office linked to the client, confidential ones included — they are
facts about the client (the delete rule depends on them), not file content; invoice totals join with the billing story.
**List:** `search` = case-insensitive substring of display, full or company name or phone (`%`/`_` literal), each with a
trigram GIN index so the `OR` can use them (email is not searched: citext has no trigram operator class without an expression
index Prisma cannot model); Arabic normalisation (hamza/alef forms) waits for global search like the cases list
(D-096). `clientType`, `isActive` filters; `sort=name|createdAt|openFiles[:dir],…` (default `name`). The order and count come
from one parameterised SQL query (Prisma cannot sort by a filtered relation count; the office id is a parameter, D-080), the
rows from Prisma. **Contact persons** (`ContactPerson`, tenant model, cascades with a purged client): `GET/POST
/clients/:id/contacts`, `PATCH/DELETE /clients/:id/contacts/:contactId`. A client with contacts has **exactly one primary**:
the first contact is primary whatever it says, `isPrimary: true` promotes (the previous one is demoted), PATCH accepts only
`true` (`validation.primaryContact` — demoting would leave none), deleting the primary promotes the oldest remaining one.
Every contact write locks the client row (`SELECT … FOR UPDATE`), so concurrent writes queue; a partial unique index is the
backstop. Contacts are hard-deleted. Audit rows name the side effects: `previousPrimaryId` when a contact is
promoted, `promotedContactId` when the primary is deleted. The number of contacts is not capped yet. Another client's contact or another office's client → 404 RES-001.
**Shared contracts:** `EmailSchema`, `PhoneSchema` and `sortParam(fields)` moved to `fields.ts` (auth and cases reuse them).
**Known limits:** a file opened for a client at the instant it is deleted can still link it (file creation does not lock the
client row). Why: the AC's encryption lands once, reusable by parties and confidential notes, and clients get the list the UI
needs without inventing billing data.

**D-103 — Staging images, compose rollout and CD; provider choices left to the owner** · Accepted (MVP-111, 2026-10-09)
The ticket asks for a staging VPS, managed services, Terraform and Sentry releases, but no VPS/database/Redis provider or
region is chosen (D-020 gives examples, D-021 is Proposed) and that choice commits spend. → The **repo side** ships now and
is provider-agnostic (any host with Docker and SSH): `apps/backend-api/Dockerfile` builds **one runtime image for the API
and the worker** (`node main.js` / `node worker.js`: same bundle, two commands — a separate worker image arrives with the
first worker-only system dependency) and a **migrate image** (`prisma migrate deploy` + the create-only plan seed, run
with the `nexlegtiq_migrator` role) = the runtime image plus schema and migrations: `prisma` became a runtime dependency
of backend-api (`@prisma/client` already installed it as a peer; now its bin is linked) and the plan seed is bundled by
webpack as `dist/seed.js` (`prisma/seed-entry.ts`), so no dev dependencies or TypeScript runner ship. Node 22
bookworm-slim, Nx `prune` output installed with `--prod`, root-owned files, `USER node`; compose runs both with a
read-only root filesystem, `tmpfs /tmp`, `cap_drop: ALL`, `no-new-privileges`. **Tesseract and Chromium are not in the
image yet** (the ticket lists them): nothing calls them, and the OCR/PDF stories add them with the code that uses them.
`infra/staging/` = `compose.yml` (Caddy TLS → api; worker; ClamAV sidecar; `migrate` as a one-off profile service),
`Caddyfile` (the **IP allow-list** `STAGING_ALLOWED_IPS` → 403 for everyone else; basic auth is not used because it would
take the `Authorization` header the SPA's bearer token needs), `deploy.sh` (validates every input, pull → migrate →
`up --wait` → `/health/ready` smoke test inside the api container, records `deployed-tag`/`previous-tag`) and
`app.env.example`. **CD:** `deploy-staging.yml` is a reusable workflow that `ci.yml` calls **after** the workspace and
secret-scan jobs pass on a push to `develop` (a red develop is never deployed); images are tagged with the full commit SHA
only (`ghcr.io/<owner>/nexlegtiq/backend-api[-migrate]:<sha>`). CI on `develop`/`main` no longer cancels in progress
(queued instead), so a rollout is never cut off mid-migration. Deploy job: GitHub Environment `staging` (secrets
`STAGING_SSH_KEY`, `STAGING_SSH_KNOWN_HOSTS` — pinned host key, no trust on first use —, `STAGING_APP_ENV` = the whole
app env as one secret, rendered on the host as `app.env` with umask 077, `STAGING_MIGRATE_DATABASE_URL`), the host logs
in to GHCR with the job's own `GITHUB_TOKEN` and logs out afterwards (no long-lived registry credential on the host); it
is **off until the repository variable `STAGING_DEPLOY=true`**. **Rollback** = `workflow_dispatch` with `tag` = an older
SHA (no build) or `deploy.sh` by hand; migrations are forward-only (expand/contract). **SPAs:** Cloudflare Pages' own Git
integration builds develop and a preview per PR — no workflow code; Cloudflare Access keeps them private. Staging runs
`NODE_ENV=production`, so the D-078 TLS and placeholder rules apply. **Not done here (owner's call, posted on the
ticket):** VPS provider/size/region, managed Postgres/Redis/bucket providers and region (D-021), domain names, the
Cloudflare account, Terraform (written once the providers are known), Sentry releases (with the monitoring story), and
demo data on staging (`seed-demo` refuses production and has no usable password — sign up instead). Why: every merge can
reach a production-like environment the day the host exists, without committing money or a region on the owner's behalf.

**D-113 — Cases list page: URL state, views and what waits for other stories** · Accepted (MVP-58, 2026-10-10)
The ticket asks for columns, filters and a create modal whose data or endpoints do not exist yet (next hearing, document
count, sub-type, client and user pickers, client selection for a new file). → `/cases` (`apps/office-app/src/features/cases`)
keeps its whole state in the URL **under the API's own parameter names** (`search`, `status`, `fileType`, `priority`,
`scope`, `clientId`, `responsibleLawyerId`, `sort`, `page`, `limit`); each parameter is checked on its own with the
contract's field schema and an invalid one is dropped (a bookmarked or hand-edited URL never breaks the page), and the
query sent is exactly what remains. Changing a filter or the search returns to page 1. **Views** are presets of filters,
not a separate parameter: All (none), Mine (`scope=mine`), Litigation (`fileType=LITIGATION`), Contracts (the four
contract types), Archived (`status=ARCHIVED`), Urgent (`priority=URGENT`); a view replaces the filters and keeps search,
sort and page size, and is shown as pressed only while the filters equal it. **Contract change:** `GET /cases?fileType=`
accepts a comma-separated list (`fileType IN (…)`), so "Contracts" needs no special case; one value still works.
**Shared API client:** `requestPage(req, itemSchema)` returns `{items, pagination}` with both checked (a missing
`meta.pagination` is SYS-001 like any contract mismatch); `casesApi(client).list(query, signal)` uses it. Table on ≥ 768 px
(sortable number, title, status, priority, last update; page sizes 20/50/100), cards with a pager below; the previous page
stays on screen while the next loads (`keepPreviousData`); first load skeleton, empty states for "no files" and "nothing
matches" (with "clear filters", which keeps sort and page size), a page past the end replaced by the last one, `ErrorState` with retry (reference per D-093). Row click and the title link open `/cases/:id`,
a placeholder until the legal-file page story. **Deferred to their stories:** next-hearing and document-count columns
(sessions, documents), sub-type (not in the list contract), **client and responsible-lawyer pickers** (no clients or team
endpoints yet — both filters already work from the URL and show as removable tags), and the **quick-create form**: "New
case" (only with `create:case`) opens the same "coming soon" dialog as the shell's quick action until client selection
exists. Why: a shareable, refresh-safe list today, built only on data the API really returns.

**D-115 — Courts, judges and prosecutors: reference rows, permissions and the platform seed** · Accepted (MVP-66, 2026-10-10) · Amends D-080, D-037
MVP-66 needed the third tenant-extension category D-080 left open, a permission the RBAC matrix lacks, and a seed whose
names the owner reviews. → **Reference models** (`REFERENCE_MODELS` = Court, Judge, next to `TENANT_MODELS`): on the
scoped client a read sees platform rows (`officeId` null) and the office's own — the condition is ANDed after the
caller's `where`, a caller's `officeId` may only be null or the current office; creates, updates, deletes and upserts
behave like a tenant model (own rows only, so a platform row is never writable without `unscoped()`); relation writes into
them are rejected like tenant ones (scalar FKs); relation filters, `_count` and list includes into them get the same
visibility; a to-one include takes no `where` (Prisma refuses one), so only the trigger-backed relations listed in
`TRUSTED_REFERENCE_RELATIONS` (`LegalFile.court`, `LegalFile.judge`, `Judge.court`) are included unfiltered — any other
to-one include into a reference model gets a `where` and fails loudly (a future `Session.court` needs its trigger first);
ordering by a relation into a reference model is rejected; raw SQL on `courts`/`judges` must take the officeId like a tenant table. **Integrity:** a platform row cannot be the
target of a composite `(…, office_id)` FK, so **triggers** give the same guarantee — a judge sits at a court its office
can see (a platform judge at a platform court), a file names a court its office can see and a judge of that court (judge
requires court) — and a court never changes office, a judge never changes court or office (so a check made on write
stays true); the API checks first (400 VAL-001 `validation.unknownCourt|unknownJudge`), the triggers are the backstop (a
race past the API check is a 500 DB-001).
`courts`/`judges.office_id` FKs are RESTRICT (SetNull would turn an office's rows into platform rows). Uniqueness: platform
rows by (jurisdiction, nameEn) — the seed key, nameEn required by CHECK —, office rows by (office, jurisdiction, nameAr),
English optional for them (409 RES-002 on a duplicate). **API** (api-conventions.md#courts): `GET /courts?jurisdiction&
courtType&search` (Arabic/English name or city, paginated, by Arabic name), `GET /courts/:id`, `POST/PATCH/DELETE /courts`
(jurisdiction defaults to the office's), `GET/POST /courts/:id/judges`, `PATCH/DELETE /courts/:id/judges/:judgeId` (an
office may add its own judge to a platform court; a judge never changes court; `isActive` retires one), CRUD
`/prosecutors` (tenant model `PublicProsecutor`, hard delete). Platform rows → **403 AUTH-100** on write (the ticket's
rule); another office's row → 404. Delete is hard and refused with **422 BIZ-011** (new code: "still referenced") while a
file or judge points at the row (the FK decides; files keep their court after a soft delete) — this tells the caller a
file uses it even if it is confidential, accepted; deletes are conditional (a concurrent second delete is 404, no second
audit row). Every write has an audit row (changed fields only). **Permissions** (no matrix row exists, none added): read with ANY of `view:all|assigned:cases`
(every role), write with ANY of `create:case|create:session` (OM, SL, L, P) — whoever opens files or schedules hearings
can add, edit or delete the office's courts, judges and prosecutors (also ones used by files they cannot see); TRAINEE,
ADMIN and EXTERNAL_COLLABORATOR read only. Owner may narrow edit/delete to `manage:office` later. **Files:** `POST /cases`
takes `courtId?`/`judgeId?`, `PATCH /cases/:id` both nullable (a new court without a judge clears the old court's judge);
the detail returns `court {id, nameAr, nameEn, courtType}` and `judge {id, fullName}`. A newly assigned judge must be
active; a retired judge stays on the files that already name them. **Seed** (`prisma/courts.seed.ts`,
run by `seed.ts` and the migrate image): 67 platform courts — for each of the ten West Bank governorate seats a magistrate,
first-instance and Sharia court, the Ramallah and Jerusalem courts of appeal, cassation, administrative, supreme
administrative, supreme constitutional, corruption crimes, Sharia appeal and supreme Sharia courts; Jordan's and Egypt's
main courts. Re-running it updates platform rows' Arabic name, type and city by key and never touches office rows.
**Deviations:** the names are **for the owner to review** (asked on the ticket, not via the `needs-decision` label, which
would stop the autopilot). To check: first-instance courts in Salfit, Tubas and Jericho (may be magistrate only); the
Jerusalem court of appeal's seat; a Hebron court of appeal; the High Court of Justice (محكمة العدل العليا) next to the
2020 administrative courts; administrative courts outside Ramallah; the seat of the Sharia appeal and supreme courts
(city empty); Gaza's courts (left out); the Jordan and Egypt selections; MSA labels such as مدنية vs حقوق. Judges are not seeded; the "inline add court/judge" UI belongs to the quick-create and session-drawer stories
(the API is ready for them); prosecutors are not yet linked to files or sessions. Why: one platform list every office
shares without ever seeing another office's additions, enforced in the extension and in the database.
**D-114 — Autopilot hardening after the first runs** · Accepted (MVP-155, 2026-10-10)
**Amends D-097.** → **Decision log merges:** `docs/context/decisions.md` is `merge=union` in `.gitattributes` — every ticket
appends its entry at the end, so two open PRs always "conflicted" there and the resolution was always "keep both" (five times
on 2026-10-10). Union keeps both sides line by line; the one case it can garble is two branches editing the **same** entry,
which reviews catch (entries are append-only, new facts go in a new entry or "review additions"). **Prisma client:** after
merging `develop` or a parent into a branch, `/autopilot` runs `backend-api:prisma-generate` before committing (lint-staged
type-checks staged files with the generated client and fails on models it does not know). **One ticket at a time** is the
default (`--parallel 2` stays available): two worktrees each running the pre-push typecheck + tests ran the development machine out
of memory twice; branches are pushed one at a time. **Merge style:** the owner merges with GitHub's button; the stacking
rules of D-097 work for squash and merge commits alike (merging `develop` into a child resolves either). Why: the loop stops
spending rounds on mechanical conflicts and on memory failures.

**D-116 — Sessions (hearings) API: conflicts, reminders rows, outcomes and the calendar** · Accepted (MVP-67, 2026-10-11)
MVP-67 left the reminder hand-off, the conflict details, edits of cancelled or held sessions and the calendar window open.
→ **Schema** (`Session`, `SessionReminder`, `SessionPartyAttendance`, tenant models): domain-model.md's Session plus
`cancellationReason` and `createdById`; composite `(…, office_id)` FKs (file cascade, users restrict, `nextSessionId` → the
next session, NO ACTION so a file's sessions can be purged together, unique per office); CHECKs: ends after it starts, a
cancelled session has no outcome, not its own next session, 0–365 reminder days (≤ 10). Court and judge: a trigger like the
file's (D-115) — a court the office sees, a judge of that court — so `Session.court`/`.judge` join
`TRUSTED_REFERENCE_RELATIONS`; a court or judge used by a session is BIZ-011 to delete. Indexes: lawyer + start (conflicts,
calendar by lawyer), office + start (calendar), file + start (Sessions tab). **Status is derived:** CANCELLED when cancelled,
COMPLETED once an outcome is recorded, else SCHEDULED (`SESSION_STATUSES`, labels `enums.sessionStatus.*`; `SESSION_TYPES`,
`SESSION_OUTCOMES` with AR/EN labels). **Access** follows the file (D-096): reads ANY of `view:all|assigned:cases` and a
visible file; `POST /sessions` `create:session`; PATCH, cancel and outcome `edit:session` + write access to the file (404
otherwise, BIZ-007 once archived); scheduling the next session from an outcome also needs `create:session`. **Attending
lawyer:** an active colleague whose role holds `create:session` (OM, SL, L) and who sees the file by their own scope, else
400 VAL-001 `validation.attendingLawyer` (`CaseAccessService.colleagueMay`, now also behind the tasks' assignee rule).
**Times** are instants with an offset (`validation.dateTime`), stored UTC and returned with `Z`; the office app sends and
shows the office's wall clock. **Conflicts** (invariant 5): another non-cancelled session of the same attending lawyer
overlapping `[startsAt, endsAt ?? startsAt + 1h)` (touching intervals allowed; held sessions count) → **409 BIZ-004** unless
`acknowledgeConflict` (recorded in the audit row). Checked on create, next session and any PATCH of start, end or lawyer,
under a per-lawyer transaction advisory lock so two overlapping writes cannot both pass. The error lists up to five
conflicting sessions as `details[]` `{field: 'startsAt', message: 'validation.sessionConflict', params: {sessionId,
startsAt, endsAt, fileNumber}}` — `sessionId` and `fileNumber` null when the caller cannot see that file (only the busy
time is shown). **`ApiErrorDetail` gains optional `params`** (shared-types) for such facts. **Edits:** PATCH only while SCHEDULED;
a cancelled or held session is **422 BIZ-012** (new code: "session not scheduled"); only changed fields are written and
audited (instants compared as instants, reminder days as sets; a new court without a judge drops the judge, audited too);
`null` clears end, court, judge, room. **Cancel** (`reason?`) is idempotent; a held session cannot be cancelled (BIZ-012).
**Outcome** (`outcome`, `minutes?`, `nextSession?`): only once the session has started (400 `validation.sessionNotHeld`) and
not cancelled; may be posted again to correct outcome or minutes; `nextSession` (once — `validation.nextSessionExists`;
after this one — `validation.nextSessionBefore`) creates and links the next session in the same transaction, defaulting
type, court, room and attending lawyer to the current one, and the judge when the court stays (a carried-over judge may
have retired since). **Reminders — deviation from the ticket's "domain events":** no event bus or queue job yet. The
session writes `SessionReminder` rows, one per `reminderDays` entry (office `courtReminderDays` by default): `scheduledFor`
= start − N × 24 h, skipped when already past, `jobId` null. Reschedule or new offsets → PENDING rows become CANCELLED and
new ones are added; cancel and outcome cancel PENDING rows; sent ones stay as history. The reminder engine story enqueues
the delayed jobs from these rows (and a sweep for PENDING rows without `jobId`), and decides channels and recipients (D-036's
`channel` column is left to it). **Timeline:** SESSION_CREATED (payload `{sessionType, startsAt}`) and SESSION_UPDATED
(`{change: UPDATED|CANCELLED|OUTCOME, sessionType, startsAt, outcome?}`); every write has an audit row (`Session`).
**Calendar** `GET /sessions?from&to&lawyerId|me&fileId`: sessions starting in `[from, to)` on visible files, cancelled
ones included (with their status); `from` defaults to now, `to` to 31 days later, at most 92 days (`validation.dateRange`);
not paginated (capped at 2000 rows). `GET /cases/:id/sessions?when=upcoming|past` is paginated (upcoming soonest first,
past latest first). `GET/PATCH /sessions/:id`, `POST /sessions/:id/cancel|outcome` (200). **Not done here:** the
`Idempotency-Key` on `POST /sessions` (api-conventions.md lists it; no idempotency store exists yet), the party
attendance API (with the parties story), AI on minutes (session summary story), prosecutors on sessions. The HTTP isolation
matrix covers `sessions`. Why: double-booking is refused at the source, reminders exist as data the engine can trust, and
a hearing never leaks a confidential file through a conflict message.
Review additions (same PR): **writes lock the session row** (`SELECT … FOR UPDATE`) and read it again inside the
transaction — PATCH, cancel and outcome work on the current state, write only the slot fields that changed, and a file
archived (BIZ-007) or deleted (404) meanwhile is caught there; a cancel racing an outcome gives BIZ-012. **Sessions last at
most 24 hours** (`validation.sessionTooLong`, CHECK `sessions_duration_check`), so the conflict query looks back one day
only. Sessions of a **soft-deleted file** never conflict; their reminders stay PENDING — the reminder engine must skip
sessions whose file is deleted or archived (and its sweep over `(status, scheduled_for)` runs `unscoped()` with each job's
office from the row). The advisory-lock key is namespaced (`session-slot:<lawyerId>`). Error fields of a next session are
prefixed (`nextSession.startsAt`, `nextSession.courtId`; `assertCourtRefs` takes a prefix). **Lists leave out the
minutes** (`SessionListItemSchema`: calendar and a file's sessions); the calendar refuses more than 2000 rows with 400
`validation.dateRange` instead of cutting them. An acknowledged conflict on PATCH is audited; every Session audit row
carries `fileId` (the audit viewer must hide rows of files its reader cannot see, as for LegalFile in D-096 — minutes and
reasons are stored in full); the CREATE row holds every field and, for a next session, `previousSessionId`. A reschedule's
SESSION_UPDATED payload adds `previousStartsAt`. Also: `sessionType` defaults to HEARING; a file's "upcoming" list and the
calendar include cancelled sessions with their status; the calendar's `from` defaults to now (the office app always
sends its range). **Known limits:** nothing in the database ties a next session to the same file (the service builds it
from the current one); deleting a file does not cancel its sessions.

**D-117 — Hearing reminder engine: recipients, due times, jobs and delivery** · Accepted (MVP-68, 2026-10-11)
MVP-68 left the recipient model, what "already past" means for several offsets, the job id format, how "in-app" is delivered
and what SENT means open. → **Rows per recipient:** `SessionReminder.recipientId` (composite FK to the office's users,
RESTRICT; migration backfills earlier rows with the attending lawyer): one row per reminder day for the attending lawyer
and one for the file's responsible lawyer (once when they are the same person; inactive users get none). D-036's
`channel` stays out: every reminder is email **and** in-app. **Due time:** 09:00 in the office's time zone, N calendar days
before the hearing's local date (`reminderRows` replaces D-116's start − N × 24 h). Offsets already due when the session is
written collapse into **one reminder due now** (the nearest offset) while the hearing is ahead — a hearing booked for
tomorrow gets one immediate reminder, not three; a due time at or after the start (a 0-day reminder of an 08:30 hearing)
is dropped. **Jobs:** `ReminderScheduler` (sessions module, used by every session write and exported for the file
lifecycle's close/archive via `cancelForFile`) writes the rows in the session's transaction and, after the commit, adds one
delayed `reminder/send-session-reminder {reminderId}` per row with job id **`reminder-{id}`** (BullMQ refuses ':' in custom
ids, so the ticket's `reminder:{id}`; stored office-prefixed, D-084) and records it in `jobId`. Reschedule, a new attending
lawyer or new offsets cancel the PENDING rows and add new ones; cancel and outcome cancel them; cancelled rows' jobs are
removed after the commit (`QueueProducer.remove`, best effort: the worker re-checks the row). **Delivery**
(`ReminderDelivery`, run by `ReminderProcessor` in the reminder's office): a row that is not PENDING does nothing; a
session cancelled, held or started, a file closed, archived or deleted, or an inactive recipient turns it CANCELLED;
otherwise the email (`hearing-reminder` AR/EN template, the recipient's `uiLanguage`, date and time via shared-utils in the
user's zone else the office's — shared-utils and decimal.js are now backend runtime dependencies) and the in-app
notification are enqueued under ids derived from the reminder (`reminder-{id}-email`, `reminder-{id}-notification`), then
the row becomes SENT. A second run, or a retry after a partial one, adds nothing. **SENT means handed to the email and
notification queues**, which retry on their own; the last failed attempt of the reminder job marks it FAILED.
**In-app:** a new `NotificationProcessor` consumes `notification/create-notification {userId, type, titleKey, params,
link}` and writes the `Notification` row (titleKey `shell.notifications.hearingReminder`, params fileNumber, startsAt,
daysBefore, sessionId; link `/calendar?session={id}`; keys and links are pattern-checked); WebSocket push joins with the
gateway. **Reconciliation:** a BullMQ job scheduler (`reconcile-reminders`, daily 02:00 UTC, registered by the worker at
boot; a Redis outage there is logged, not fatal) re-adds the job of every PENDING reminder of active offices, `unscoped()`
then office by office in `TenantRunner`; BullMQ ignores ids it already holds, so only lost jobs come back.
**Acknowledgement:** `POST /sessions/reminders/:id/ack` (200, the reminder) by its recipient only — anyone else, another
office or a malformed id is 404; acknowledging again keeps the first time; not audited (no data changes but a "seen"
mark). `GET /sessions/:id` returns `reminders[]` (day, due time, status, recipient, sent and acknowledged times) for the
session drawer; lists leave them out. `REMINDER_STATUSES` joins shared-types (labels `enums.reminderStatus.*`).
**Not done here:** the session drawer itself (office-app calendar story); reminders do not follow a change of the file's
responsible lawyer (the reassign story must call `reset`); a job of an office suspended when it ran completes skipped and
stays in Redis 7 days, so its row stays PENDING until the office is active again and the reconciliation runs after that.
Why: every lawyer on a hearing is reminded at a sensible hour in their own language, never twice, and a lost Redis does
not lose a court date.
Review additions (same PR): **a recipient who can no longer see the file** (made confidential, taken off the team, role
lowered) is not reminded — delivery runs the attending-lawyer check (`CaseAccessService.colleagueMay`, by the recipient's
own scope) and cancels the row (`RECIPIENT_NO_ACCESS`), so a confidential file's number and title never reach someone who
gets 404 on it. **No repeated reminders:** when a session keeps its time (new offsets or a new attending lawyer), a
recipient gets no new reminder for a day no later than one already SENT to them; a new time reminds everyone again.
Enqueues after the commit run in parallel (a Redis outage costs one 2 s timeout, not one per row). **Acknowledging** a
reminder not yet sent returns it unchanged (200, `acknowledgedAt` null). **Left to the file lifecycle story:** closing or
archiving a file must call `ReminderScheduler.cancelForFile` (until then delivery cancels those reminders when due, and
their jobs stay in Redis until then), and reopening must schedule its upcoming sessions again (`reset`); changing a file's
confidentiality or team does not reset reminders (delivery is the backstop). **Accepted race:** a reschedule committed
while a reminder is being handed over can still let the old reminder out once.
**D-118 — Legal-file page: tabs in the URL, header actions and what waits for other stories** · Accepted (MVP-60, 2026-10-11)
MVP-60 asks for header actions, tabs and cards whose endpoints are not built yet (lifecycle routes, sessions, documents,
tasks). → `/cases/:id` (`apps/office-app/src/features/cases`, lazy page) loads `GET /cases/:id` (shared API client gains
`casesApi.get|update|remove`); **404 RES-001** (missing, deleted, another office's or a confidential file the user may not
see), and a malformed id without asking the API, show the 404 page inside the shell, also when a refetch finds the file gone; no 4xx is retried, other failures `ErrorState` with retry (one automatic retry). **Tab** in
`?tab=` (`details` is the default and leaves the URL clean; switching tabs **replaces** the history entry, so back leaves the file); an unknown tab, or one the user
may not open, falls back to Details, so a shared link never breaks. Tabs Billing (`view:all|assigned:invoices`), AI (`use:ai`)
and Audit (`view:audit`) are shown only to holders, the others to everyone; every tab but Details is a "coming soon" state
until its story ships. **Header:** back (history, else `/cases`), `number • title` (number in `<Ltr>`), status, priority,
confidential tag, responsible lawyer; an Edit button and a ⋮ menu offering only what the user may do (`fileActions`, UI only,
the API re-checks): Edit = `edit:any:case`, or `edit:assigned:case` when assigned (D-051); Reassign = `edit:any:case`;
Change status / Archive = `close:case` or `reopen:case`, a LAWYER only as the responsible lawyer (D-052, D-081); Delete =
`delete:case` and `edit:any:case` (the API checks a delete as a write, D-096). **Archived files offer nothing** and show a read-only banner (D-052). Reassign, Change status and Archive
open a "coming soon" dialog until the lifecycle story adds their routes. **Edit** is a drawer (not inline) over
`PATCH /cases/:id` with title, priority, sub-type, court case number, description, billing terms (only with
`generate:invoice`) and confidentiality (only the office manager or the responsible lawyer, D-096); it sends **only the
fields that changed**, trimmed, `''` → `null` for optional ones; validation from `UpdateCaseSchema`, VAL-001 details on the
fields; the answer replaces the cached file and lists refetch. **Delete** asks first (`ConfirmModal`, danger), then
returns to `/cases`; a failure is a notification. **Details:** cards for the overview (type, sub-type, dates, jurisdiction,
confidential, description), court (Arabic name in Arabic, English name in English with the Arabic one as fallback, type,
judge, court case number), billing (only when the API returned the terms), clients (primary marked), team, key counts
(clients, team, parties, notes) and the next hearing. **Deferred:** the next-hearing card shows "no hearing scheduled"
until the sessions API is merged (its PR is still open); document and task counts with their stories; the court/judge and
team/lawyer pickers (court and judge are changed by `PATCH` already, but there is no picker UI yet — the quick-create and
session stories build one); inline edit. Why: one page every later tab plugs into, with nothing offered that the API would
refuse.

**D-119 — Documents data model, folders and storage accounting** · Accepted (MVP-71, 2026-10-17) · Amends D-035
MVP-71 left the folder rules, who may change folders, the status list and how storage is counted open; the
`uploadedBy user|clientUser` column needs the portal's `ClientUser`, which does not exist yet. → **Models** (tenant, every
reference a composite `(…, office_id)` FK, D-079/D-095): `DocumentFolder` (file, `parentId?`, `name?`, `systemKey?`),
`Document` (mirrors its current version: storage key, size, checksum, MIME type; `documentType`, `status`, `ocrStatus`,
`language?`, `isConfidential`, `sharedWithClient`, `folderId?` and `sessionId?` of the **same file** — the FKs include
`file_id` —, `uploadedById`, soft delete), `DocumentVersion` (every stored upload including the first, append-only: no
`updatedAt`, UPDATE revoked from the app role) and `DocumentText` (one row per version, kept out of `Document`).
**Amends D-035:** `DocumentStatus` = `UPLOADED, SCANNING, PROCESSING, READY, FAILED, QUARANTINED` (the malware scan and a
positive result are states of their own); `OcrStatus` = `NOT_NEEDED, PENDING, DONE, FAILED`. Storage keys must start with
the row's `office_id/` and checksums are lower-case hex (CHECKs). Portal uploads add `uploadedByClientUserId` with the
Client Portal; the API that uploads, versions and downloads documents is the upload story's.
**Search:** a trigger (not generated columns: `unaccent` is STABLE) fills `search_vector_simple` (`simple` over
`nlq_normalize_ar(unaccent(text))`) and `search_vector_english` (D-059), GIN-indexed; only the first 500,000 characters are
indexed (a tsvector is capped at 1 MB). The read-only role cannot read `document_texts` (migration and `db-roles.sql`).
**Folders:** every file gets six root **system folders** (`FolderSystemKey` = PLEADINGS, EVIDENCE, COURT_ORDERS, CONTRACTS,
CORRESPONDENCE, CLIENT_UPLOADS) from an `AFTER INSERT` trigger on `legal_files`, so files created any way (API, import,
seed) have them; existing files were backfilled by the migration. A system folder has a key and no name (the UI shows
`enums.folderSystemKey.<KEY>` in the reader's language), sits at the root and cannot be renamed, moved or deleted
(**422 BIZ-014**, new). Custom folders: a name of 1–100 characters, unique among siblings case-insensitively and
Arabic-normalised (unique index, 409 RES-002), at most **5 levels** deep, never moved into themselves or their subtree
(400 VAL-001 `validation.folderDepth|folderMove|unknownFolder`). Changes lock the file row (`FOR NO KEY UPDATE`, which
does not block inserts referencing the file) so concurrent moves cannot build a cycle; the database refuses a folder as its
own parent. Delete is hard and refused with **422 BIZ-013** (new) while the folder has subfolders or live documents; its
soft-deleted documents move to the file's root; a document uploaded meanwhile makes the FK refuse it (also BIZ-013). Rows
created by the database use `nlq_uuid_v7()` (PostgreSQL 17 has no `uuidv7()`). **API** `GET/POST /cases/:id/folders`,
`PATCH/DELETE /cases/:id/folders/:folderId`: list with ANY of `view:all|assigned:cases`; create, rename and move with
`upload:document`; delete with `delete:document` (no matrix row exists for folders, none added). Access follows the file:
`CaseAccessService.assertFileAccess` gains a **`contribute`** mode — the caller sees the file and it is not archived
(BIZ-007) — because adding to a file needs no `edit:*:case` (a paralegal files documents on a lawyer's case). Every write has
an audit row (changed fields only). **Storage quota:** `StorageUsageService.usedBytes()` = the sum of every stored version's
size in the office, soft-deleted documents included (their objects stay until purged); the entitlement check reads it when
uploads exist. Why: folders and searchable text land once with their integrity in the database, before the upload, OCR and
portal stories build on them.
Review additions (same PR): folder writes **re-check the file under the lock** — deleted meanwhile is 404, archived
meanwhile BIZ-007 (D-096's conditional writes); a file holds at most **200 folders** including the six defaults (400 VAL-001
`validation.folderLimit` on `name`), which keeps the unpaginated list and the tree checks small. The folder list is ordered
system folders first (in `FolderSystemKey` order), then by name. **Who organises folders:** holders of `upload:document`
(TRAINEE and EXTERNAL_COLLABORATOR included, on files they are assigned to) may create, rename and move any custom folder
of the file, not only their own; owner may narrow rename/move to `edit:*:case` later. A custom folder may carry the same
name as a system folder's label (the label is per language, so the database cannot compare them). Storage keys are unique
across the platform, `DocumentText` references its version (`(document_id, version_number)`, cascade), `ocrStatus` defaults
to PENDING (the upload story sets NOT_NEEDED for files with embedded text) and `currentVersion` is a denormalised copy of the
newest version number. The read-only role keeps column access to `documents` and `document_versions` (file names may name
clients, as client and case tables already do). The confidential-document count in `documentCount` and the HTTP isolation
half for documents belong to the upload story. Migration `tune_document_indexes` drops the redundant `folder_id` index and
pins `nlq_uuid_v7()`'s `search_path`.

**D-120 — Re-check the session after a confirmed email** · Accepted (MVP-158, 2026-10-19) · Amends D-090
D-090 left the session untouched after a successful verify-email call (the link may be another account's), so the
"confirm your email" banner stayed until the next refresh, up to 15 minutes. → When the link is confirmed in a **signed-in**
tab, the page runs `restoreSession()` (a refresh under the cross-tab lock, D-089) and, once that refresh confirms the session,
broadcasts `signedIn`, so every tab of the browser re-reads its own session from the server. A link opened in a new tab is
usually confirmed while that tab's start-up restore is still running: the page waits for the restore to settle and re-checks
if it ends signed in (the start-up refresh may have answered before the verification committed). The session is still **never patched from the verify answer**: the
refresh reports the signed-in user's own `emailVerified`, so another account's link leaves the banner in place. A refusal
ends the session as at start-up; offline, a 5xx or a 429 keeps it and the success page (the banner then clears on the next
refresh). Signed out: no refresh. Why: the user sees the result of what they just did, without trusting a link's owner.

**D-121 — Clients UI: list, drawer, contacts and the client picker** · Accepted (MVP-54, 2026-10-19)
MVP-54 asked for a list, a create/edit drawer with a contacts editor and an inline client picker, but no team endpoint
exists for the primary lawyer and the client profile page is its own story. → `/clients`
(`apps/office-app/src/features/clients`, behind `manage:clients`, D-091) keeps search, `clientType`, `isActive`, sort and
paging in the URL **under the API's parameter names**, each checked with the contract field schema as for cases (D-113);
the search runs **as the user types, debounced 300 ms** (the cases list searches on Enter), and clearing the filters empties
the box. Columns: name (an "inactive" tag), type, phone and email (`<Ltr>`), open cases, last activity (`updatedAt`);
sortable by name and open cases (what the API sorts). Empty states: "add your first client" (CTA) or "nothing matches"
(clear filters). **Drawer:** one form for create and edit; the fields follow the type — a person gets full name and national
id, an organisation (company, government body, NGO, partnership) its name, tax id and industry; **the name typed is both
`displayName` and the legal `fullName`/`companyName`** (changing the type moves it and clears the other), so there is one
name to enter; edits send only changed fields (`''` clears), validation from the contracts. **Contact persons** need the
client to exist: creating a client keeps the drawer open on it, now in edit mode, to add them; add, edit, make primary
(the server keeps exactly one, D-108) and remove after a confirm. A row (click or Enter) opens the client in the drawer
until the client profile page exists. **`ClientSelect`** (exported for the quick-create case form): an AntD `Select` that
searches active clients on the server (debounced, 20 results) and offers "New client" with what was typed, opening the same
drawer and picking the created client. **Not done here:** the primary-lawyer picker (no team endpoint yet — the field stays
unset from the UI), deleting a client (not in the AC; the API refuses one with open files, BIZ-010), the shell's
"+ Client" quick action (still "coming soon"), phone-sized cards (one horizontally scrolling table for now). Why: offices can
add and find their clients today, and the case form gets a ready picker.
Review additions (same PR): **a type change clears the old type's identification** (a person's national id, an
organisation's tax id and industry: they could no longer be seen or corrected) and moves the name to the new legal-name
column; **a rename keeps a separately stored legal name** — the legal name follows the display name only where they were
equal (or empty). The client detail and the write bodies (which hold national and tax ids) are **not kept in memory after
use** (`gcTime: 0`); contact writes refresh only that client. The search box follows the URL on back/forward too, and a
search of only spaces is ignored. Contact buttons' accessible names and the removal sentence are translated keys with the
name isolated (`isolate`, so office-app now declares shared-utils, D-074); "make primary" has its own request state, so it
never locks a contact being edited. **`ClientSelect` needs `manage:clients`** (`GET /clients`): every role holding
`create:case` holds it (OM, SL, L, P), so the case form can always use it. The ticket's **"RTL snapshot"** is asserted as
direction, Arabic labels and axe (list and open drawer) instead, as in D-091. Also added: `clientsApi`/`ClientListParams` in
shared-api-client (D-089's resources) and the `clients` translation namespace (D-087).

**D-123 — Quick-create case and the people directory** · Accepted (MVP-59, 2026-10-19)
MVP-59 asks for responsible-lawyer and paralegal pickers, but no endpoint lists an office's people (team management is
its own story), billing defaults "from office settings" while the office settings API does not exist yet, and an entry
point on the client profile, which has no page yet. → **`GET /users/directory`** (`src/modules/users`): the office's
**active** users as `{id, fullName, role}` by name — no email, status or invitations (the team-management list adds those)
— readable with ANY of `create:case`, `create:task`, `assign:task`, `create:session` (the roles whose forms have
people pickers: OM, SL, L, P; admin staff, trainees and outside collaborators, who see only assigned files,
get 403); not paginated (capped at 500); no `:id`, so `users.int.spec.ts` (another office's people never listed) stands
in for the HTTP isolation matrix entry. **Modal** (`apps/office-app/src/features/cases`): one `QuickCreateCaseModal`, its own lazy
chunk, mounted once by `QuickCreateCaseHost` in the shell (only for `create:case`), opened from the shell's **+ Case**
quick action, the cases list's **New case** and **Ctrl+Alt+N** (physical `KeyN`; ignored while typing in a field, since
Ctrl+Alt is AltGr on Windows layouts that type characters with it). Fields: title, client (`ClientSelect` with inline
create, D-121; one client at creation, `clientIds = [it]` and primary), type, priority (MEDIUM), sub-type, responsible
lawyer (the directory's OFFICE_MANAGER/SENIOR_LAWYER/LAWYER — the API's rule — **defaulting to the caller** when eligible),
optional paralegal (PARALEGAL), optional court (server search, platform and office courts) and judge (active judges of
that court; changing the court clears it), billing method with rate or fee **only for `generate:invoice`** (D-096) and
left empty by default — the API applies the office's billing method and rate (the "defaults from office settings" of the
ticket, without reading them in the browser), and description. Validation from `CreateCaseSchema`; VAL-001 details land
on their fields. **"Create"** closes the modal where the user is; **"Create & open"** goes to `/cases/:id`; both show
"Case {number} created" (number isolated). The **+ Client** quick action now opens the client drawer (D-121's "coming
soon" is gone); + Task stays a placeholder. **Deferred:** the client-profile entry point (no profile page), the Cypress
journey (the Cypress project arrives with the E2E story; every control has a `data-testid`), confidentiality and court
case number at creation (edited on the file page, D-118). Why: a case in a few keystrokes from anywhere, using only what
the API already checks.
**D-122 — Plan entitlements, quota checks and read-only mode** · Accepted (MVP-51, 2026-10-19)
MVP-51 left open what "expired" means, which code a read-only write gets, which flags a plan has when its `features`
JSON is empty (every seeded plan's is), and who may read the subscription. → **Entitlements**
(`src/modules/subscriptions`, global module): `resolveEntitlements` takes the office's live subscription (TRIALING/ACTIVE,
at most one, D-079) or else its newest, and the plan's `maxUsers`, `storageQuotaMb`, `aiQuotaMonthly` and flags. **Effective
status:** a TRIALING subscription whose `trialEndsAt` (else `currentPeriodEnd`) has passed, or an ACTIVE one whose
`currentPeriodEnd` has passed, is **EXPIRED** at once — no job has to update the row; PAST_DUE is a grace period with full
access until the platform admin ends it; CANCELLED/EXPIRED (and an office without any subscription, which signup never
leaves) are **read-only**. **Flags:** `ai`, `clientPortal`, `googleVisionOcr`; only boolean values in `Plan.features`
count (other keys such as `customPricing` are ignored), and a flag a plan does not set defaults to **on for `ai` and
`clientPortal`** (MVP features of every plan, D-002) and **off for `googleVisionOcr`** (a paid fallback), so no plan row
had to change; the admin panel can switch flags per plan. Entitlements are cached **per process for 30 s** per office
(`invalidate(officeId)` drops one) — a plan change applies within 30 s; Redis (`o:{officeId}:entitlements`) when the admin
panel edits plans or a second API runs. **`SubscriptionGuard`** (global, after PermissionsGuard, office realm only):
`@RequireFeature(flag)` → 403 **AUTH-102**; while read-only every method but GET/HEAD/OPTIONS → 403 **AUTH-104** (new code:
"subscription ended, office read-only"), except routes marked `@AllowWhenReadOnly()` — today only `POST
users/me/password` (the caller's own account); sign-in, refresh, logout and the email links are public routes and keep
working. Entitlements are loaded only for a gated route or a write. **Quota helpers** on `EntitlementsService` for the
stories that add users, bytes or AI calls: `assertUserSlot()` → 422 **BIZ-008** when active users plus pending, unexpired
invitations reach `maxUsers`; `assertStorageFor(bytes)` → 403 **AUTH-103** beyond the quota (usage = every stored version,
D-119; `StorageUsageService` moved to this module so documents can depend on it without a cycle); `assertAiQuota(used)` →
AUTH-103 (the AI usage records arrive with the AI quota story, which passes this month's count); `assertFeature(flag)` →
AUTH-102. Suspended offices were already refused at login, refresh and on every request (AUTH-006, D-082). **`GET
/offices/me/subscription`** `{plan, status, readOnly, periodEnd, trialEndsAt, limits{users, storageMb, aiMonthly},
features, usage{users, storageMb, aiThisMonth}}` (null limit = unlimited; storage in MiB rounded up; `aiThisMonth` is 0
until AI usage is recorded) is readable by **every office user** — the read-only banner depends on it; plan and usage are
not sensitive inside the office. **Office app:** `/settings` (still `manage:office`) shows the Subscription section — plan,
status, trial/period end, usage bars (none for an unlimited limit), features and "contact us to upgrade" (no contact address
in the specs yet); the shell shows a read-only banner to everyone while `readOnly`. `SUBSCRIPTION_STATUSES` joins
shared-types (labels `enums.subscriptionStatus.*`), the `settings` namespace joins shared-i18n. **Tests:** HTTP integration
tests' offices now get an unlimited ACTIVE subscription (`liveSubscription()`), since an office without one is read-only.
**Known limits:** the Palestine freemium ends after 180 days into read-only with no self-service renewal until the admin
panel ships (D-005: manual payments); a 30 s window after renewal can still refuse writes.
Why: limits and access follow plan data, not code, and an ended subscription keeps the office's data readable.
Review additions (same PR): **limits and usage** (head count, storage) are returned only to `manage:subscription`
holders — everyone else gets `limits: null, usage: null` with plan, status, `readOnly` and flags, which is all the banner
needs (an external collaborator learns nothing about the office's size, and the banner costs no counting). **Realms:** the
guard binds every caller acting for an office — office staff now, portal clients when that realm ships (their uploads
are writes) — and skips only public routes and the platform realm. `POST sessions/reminders/:id/ack` (a "seen" mark,
D-117) is also `@AllowWhenReadOnly()`. The live subscription is read by status first (index `(office_id, status)`), then
the newest row; expired cache entries are dropped on a miss; Prisma access sits in `SubscriptionsRepository`. A write
refused with AUTH-104 makes the office app reload the subscription, so the banner appears at once. **CANCELLED ends
access at once** (read-only) whatever `currentPeriodEnd` says: the admin who records a cancellation with paid time left
keeps the subscription ACTIVE until that period ends and sets `cancelledAt`; PAST_DUE grace has no end until the admin
acts — the admin-panel story must surface such offices. **Not yet applied:** no route carries `@RequireFeature` (AI,
portal and OCR stories add it with their endpoints) and `aiThisMonth` stays 0 until the AI quota story records usage and
calls `assertAiQuota`; user invitations call `assertUserSlot` and uploads `assertStorageFor` in their stories.

**D-125 — Office profile and settings: endpoints, validation, the idle timeout and the settings page** · Accepted (MVP-48, 2026-10-20) · Amends D-090
MVP-48 left the bounds of several settings open, how the office's idle timeout reaches users who cannot read the settings,
and how the page splits into sections. → **API** (`src/modules/offices`, `manage:office` = OFFICE_MANAGER on all four
routes, others 403 AUTH-100; `me`-scoped, so there is no other office to address): `GET/PATCH /offices/me` — name,
registration number, tax id, phone, email, address, website (`http(s)://` only, `validation.website`), jurisdiction,
default language, currency (ISO-4217 the runtime knows, `CurrencySchema` now shared with signup) and time zone (an IANA
zone `Intl` accepts, `validation.timeZone`); `accountType` is shown, not edited (it only chose the signup plan, D-083).
`GET/PATCH /offices/me/settings` — `courtReminderDays` 1–30 (at least one), `taskReminderDays` 0–30 (0 = the due day; may
be empty), each list ≤ 10 entries, duplicates refused (`validation.duplicate`), stored largest first; `defaultBillingRate`
(decimal string, `null` clears) and `defaultBillingMethod`; `taxRatePercent` 0–100 with 2 decimals; `enableAi`,
`enableOcr`; `fileNumberFormat` checked by the contract with the rules of D-095's parser (a unit test keeps the two in
step on the same fixtures) and again by the parser before saving; `sessionIdleMinutes` 15–120 (D-053); `auditRetentionDays`
365–3650 (D-060 "upward only" is read as "never below 365": lowering back towards a year is allowed). Both PATCHes take
only the fields sent (`''`/`null` clears an optional profile field), write and audit only those whose value changed
(decimals compared as numbers; `Office` / `OfficeSettings` UPDATE rows with old and new values), and lock the office row
`FOR UPDATE` so concurrent edits queue and the audit's old values are right. **Effect:** nothing caches settings — new
files read the number format, billing defaults, currency and jurisdiction at creation, sessions the reminder days and the
time zone at each write — so a change applies to the next file or hearing and never rewrites existing ones (the page says
so for currency). `enableAi`/`enableOcr` are stored only: the AI and OCR stories check them (with the plan flags, D-122).
**Idle timeout (amends D-090):** the session answer of login and refresh carries `user.idleMinutes` (the office's
`sessionIdleMinutes`, 30 without a settings row), so every user's tab adopts it; the manager's own tab applies a change at
once, other tabs and users at their next refresh (≤ 15 min). A page load still judges "idle since the last visit" with the
default 30 minutes, because the office's value is only known once the refresh has answered. **Page** `/settings`: five
cards — Office profile (identity and contacts), Preferences (jurisdiction, language, currency, time zone; same endpoint),
Practice defaults (reminders, billing, tax, case number format, AI/OCR), Security (idle timeout, audit retention) and the
read-only Subscription (D-122). Each card is its own form with Save and Discard, sends only its changed fields, validates
with the contract first and puts VAL-001 details on their fields; a saved name updates the header at once. **Unsaved
changes:** leaving the page in the app while any card has changes asks first (react-router `useBlocker`, "Stay" / "Leave"),
and closing or reloading the tab triggers the browser's own prompt. **Not done here:** a logo upload (storage of office
assets is not specified), statistics and export (`GET offices/me/statistics`, `POST offices/me/export`, their own stories),
an audit row for reading settings (reads are not audited elsewhere either).
Review additions (same PR): **time zones are stored under their canonical IANA name** (`asia/hebron` → `Asia/Hebron`)
and only region zones and UTC are accepted — fixed offsets (`+02:00`, `Etc/GMT+2`) have no daylight saving, so file-number
years and 09:00 reminders would be an hour off half the year; the page offers the same list. The website refuses control
and bidi characters like any plain text, and the session's `idleMinutes` is checked as 15–120 like the column. The office's
**tax id and registration number are not encrypted** (D-056 covers individuals' ids; an office's are on its letterhead) and
are audited in full. Changing the reminder days applies to hearings written afterwards: **reminders already scheduled
stay as they were** (D-117 recomputes them only when the hearing itself changes). While the subscription is read-only
(D-122) the settings cannot be changed either, security ones included. The changed-fields helper behind audit rows is
now one function (`common/audit/changes.ts`, also used by cases).
**D-124 — Team management: deactivation with reassignment, role changes and reactivation** · Accepted (MVP-50, 2026-10-20)
MVP-50 left who may change what, what "open file" means, what happens to the leaver's team rows, reminders and their own
role open. → `src/modules/users` (`TeamService`), all `manage:users` (OFFICE_MANAGER only): **`GET /users`** — every user of
the office, active first, then by name: id, name, email, role, `isActive`, `openFiles` (live OPEN or SUSPENDED files they
are the responsible lawyer of — what BIZ-010 counts as open, D-108), `lastLoginAt`; not paginated (500, like the directory,
D-123). **`GET /users/:id/open-files`** `[{id, fileNumber, title}]` — what the wizard must reassign (the cases list cannot
filter OPEN + SUSPENDED in one call). **`PATCH /users/:id/role`** `{role}`; **`POST /users/:id/deactivate`**
`{reassignments: [{fileId, newResponsibleLawyerId}]}` (200, the member); **`POST /users/:id/reactivate`** (200). Another
office's user or a malformed id → 404 RES-001. **Last manager:** demoting or deactivating the last **active**
OFFICE_MANAGER → 422 BIZ-001; every team write takes a per-office transaction advisory lock (`team:<officeId>`), so two
managers cannot demote each other at the same time. **A role without a lawyer role** (PARALEGAL, ADMIN, TRAINEE,
EXTERNAL_COLLABORATOR) is refused to an active user who is still responsible for open files — 400 VAL-001 on `role`
(`validation.roleHasOpenFiles`): a file's responsible lawyer must hold a lawyer role (D-096); the manager reassigns through
the deactivate wizard first. **Deactivate** (one transaction): the reassignments must name **exactly** the user's open files
(a missing or foreign file → 400 VAL-001 `validation.reassignAllFiles` on `reassignments`, nothing changed); each new lawyer
an active OFFICE_MANAGER/SENIOR_LAWYER/LAWYER other than the leaver (VAL-001 `validation.responsibleLawyer` on
`reassignments.<i>.newResponsibleLawyerId`); then `isActive = false`, **every refresh token revoked** (the JWT guard already
refuses their access token on the next request, D-082), and per file: `responsibleLawyerId` changed, the leaver's
`FileTeamMember` row removed and the new lawyer's row made (or turned into) RESPONSIBLE_LAWYER (one per file, D-095), a
`FILE_REASSIGNED` timeline event (`{fromUserId, toUserId, reason: 'DEACTIVATION'}`), an UPDATE audit row on the file, an
in-app `file.reassigned` notification to the new lawyer (`shell.notifications.fileReassigned`, link `/cases/:id`; not when
the manager takes the file), and the **reminders of the file's upcoming hearings are reset** (`ReminderScheduler.reset`,
hearing time unchanged, as D-117 asked of the reassign story); a User UPDATE audit row records `reassignedFiles`.
Deactivating an inactive user does nothing (200). Closed and archived files keep the leaver as their lawyer (history).
**Reactivate:** checks a free seat first (`EntitlementsService.assertUserSlot`, 422 BIZ-008, D-122); an active user is a no-op.
Every change has an audit row with old and new values. **UI** `/team` (`apps/office-app/src/features/team`, `team`
namespace): table of the team (name, "you" tag, email in `<Ltr>`, role select, status tag, open files, last sign-in relative),
role changed in place (a toast, or the error as a notification), Deactivate opens the **wizard**: the open files (number
`<Ltr>` + title) each with a lawyer picker (active lawyers of the team except the leaver) and "give every file to" for more
than one file; the API's refusal refreshes the list. **Your own row is read-only** (no role select, no deactivate) — a
manager cannot lock themselves out from this page; another manager can. A change refreshes the team, the directory, the
cases and the plan usage. **Not done here:** sessions where the leaver is the **attending lawyer** and tasks assigned to them
keep pointing at them (delivery cancels their reminders, D-117; the calendar and tasks stories can offer a reassignment);
invitations (their own story); a deactivated user's paralegal/member rows on other files stay as history. **Known limit:**
the reactivate seat check reads usage outside the lock's transaction snapshot (two reactivations at once are serialised by
the lock, an invitation accepted at that instant is not).
Review additions (same PR): **opening a case cannot race a deactivation or role change** — case creation now checks the
responsible lawyer and paralegal with `SELECT … FOR SHARE` (active, right role, the office's id as a parameter) and team
writes lock the user's row `FOR UPDATE` after the team lock, so either the case commits first and must be reassigned, or
the check waits and sees the change. Each reassignment is a **conditional update** (still the leaver's, open and live) —
a file deleted or closed meanwhile is 409 RES-003 and nothing is written. **Responsible paralegal** (D-096: an active
PARALEGAL): deactivating them, or changing a PARALEGAL's role, clears `responsibleParalegalId` on their open files (audited
as `paralegalFilesCleared`); their team rows stay, so a promoted paralegal keeps working on those files. The open-file list
is capped at the contract's 500 reassignments; deactivation runs with a **60 s transaction timeout**
(`UnitOfWork.run(work, {timeoutMs})`, Prisma's default is 5 s) since every file and upcoming hearing is rewritten.
**Role changes** leave tasks and attending-lawyer sessions as they are, like deactivation; the API allows a manager to demote
or deactivate themselves while another active manager exists (only the UI hides it); **reactivating** someone restores their
old team rows and so their access to those files, confidential ones included. UI: non-lawyer roles are disabled for a
responsible lawyer of open files, the API's VAL-001 reason is shown in words (role select, the wizard's list rule, and per
file on its picker), buttons are named per person, statuses read Inactive / غير نشط (as for clients) and Arabic says
"إيقاف الحساب" for deactivate.

**D-129 — Realtime gateway: authentication, rooms, ids-only events and the office-app client** · Accepted (MVP-94, 2026-10-20) · Amends D-098, D-117
MVP-94 left the token hand-off, what happens at token expiry, what an event carries, multi-instance delivery and the
portal namespace open. → **Gateway** (`src/common/realtime`, API process only): socket.io namespace `/ws` on the default
`/socket.io` path. The client sends the same access token as the HTTP API in the connect packet (`auth.token`, never the
URL); it is checked by **`AccessTokenVerifier`**, now shared with `JwtAuthGuard` (HS256, issuer, audience, then role,
user and office active reloaded from the database — D-082, D-081). A refusal is a `connect_error` whose `data.code` is the
error code (AUTH-002 expired, AUTH-003, AUTH-006, AUTH-010). An admitted socket joins `office:{officeId}` and
`user:{userId}` and is **disconnected when its token expires**, so a deactivated or demoted user keeps a live channel at
most one token lifetime (≤ 15 min). Clients cannot send events (no handlers). **Delivery:** `@socket.io/redis-adapter`
shares rooms between API instances and `RealtimePublisher` (global, API and worker) emits through
`@socket.io/redis-emitter`, both keyed `{BULLMQ_PREFIX}:socket.io`; `useRealtimeAdapter(app)` is called by `main.ts`
(not by `configureApp`), so unit-test apps never contact Redis; Redis down at boot is logged, not fatal (D-084). Every
ioredis client has an error listener; closing drops a connection that never became ready (`quit` would wait forever).
**Events carry ids only** (`RealtimePayloadSchemas` in shared-contracts; checked before emitting — a bad payload is a
programming error — and again by the client): the app refetches through the API, which applies every access rule, so an
event never leaks a confidential file's content. `toOffice` takes the office from CLS only. Emitting is best effort and
runs **after commit** (`afterCommit`); a Redis failure is logged, never thrown. **Wired now:** `task.assigned` +
`notification` to a colleague given a task, `task.updated` to the assignee(s) on edit and status change,
`session.scheduled` to the attending and responsible lawyers on every new hearing (also a next session),
`session.reminder` to the recipient when a reminder is handed over, `notification` whenever the worker writes a
`Notification` row. **Not wired yet (contract ready):** `document.processed` and `document.summary.ready` (the upload/OCR
and summary stories emit them), `ai.job.completed|failed` (AI stories). **Deviation — portal namespace:** the client portal
realm (`ClientUser`, `client:{id}` rooms) does not exist yet; its story adds a second namespace with its own token check.
**Office app** (`features/realtime`): one socket per access token — a refreshed token closes it and opens a new one
(re-authentication), sign-out closes it; socket.io's reconnection with backoff 1 s → 30 s (randomised) after a network
drop; on `connect_error` AUTH-002 or a server disconnect (expiry) it calls `auth.refresh()` under the cross-tab lock
(D-089) — **not `restoreSession`**, which records activity: a live socket must never keep an idle shared computer signed
in (D-053); a refused refresh ends the session as `expired`, offline keeps it. `useRealtime(event, handler)` (latest
handler, no resubscribe), `useInvalidateOn(event, payload → queryKeys)`, and `RealtimeBridge` in the shell invalidates by
prefix (`tasks`, `sessions`, `documents`, `notifications`, `cases/detail/{fileId}`) — a key nobody cached costs nothing.
Tests: integration (real Redis, two offices — events stay in their office; refusals; expiry disconnect) and Vitest with a
fake `socket.io-client`. Versions: socket.io 4.8.3 (pinned with the client), `ioredis` declared at BullMQ's 5.11.1.
**Known limits:** events missed while a socket is down are not replayed (a refetch on the next page view or event
covers it); every token refresh reconnects (one short gap per 15 min). Why: live updates without a second auth path, and
no event that could carry data across offices or past the API's access rules.
Review additions (same PR): **amends D-098 and D-117** — the WebSocket push they deferred is done (`task.assigned` and
`notification` for task assignment; `session.reminder` and the `notification` event from the notification queue
consumer). **Redis failures never crash a process:** the emitter fires `publish` without handling its promise, so the
publisher hands it a client whose `publish` logs and swallows a rejection; the adapter's subscriber waits for Redis
(`maxRetriesPerRequest: null`) instead of failing a retry count. **Hardening:** the root namespace `/` refuses every
connection (socket.io always serves it; nothing lives there) and the server speaks WebSocket only (polling would need
sticky sessions across instances; CORS without credentials — no cookies travel); at most **10 sockets per user** per
API instance (`RATE-001` as `connect_error`); the expiry timer belongs to the socket (cleared on its disconnect,
`unref`), and a client that left while its token was checked holds nothing. **Deactivation closes the user's sockets
at once** on every instance (`RealtimePublisher.disconnectUser`, after commit) — their reconnect is refused; a password
reset or change does not (the user's access tokens stay valid for their 15 minutes, D-086, so a closed socket would just
reconnect). `task.updated` goes to the **previous** assignee only (a new assignee gets `task.assigned`; for a personal
task the old assignee then gets 404 on refetch — only the id is sent), bulk assignment included. **Office app:** a
refused renewal is judged like the start-up restore (401, 403 AUTH-006/010 → signed out); a renewed session that
belongs to **another user** (signed in in another tab) is adopted through `startSession`, which clears the previous
user's data; a refusal that is not about the token (SYS-001, the per-user cap) is retried once after 5–30 s with
jitter. **Known limits:** delivery across several API instances is built on the Redis adapter but tested with one;
while Redis is down events are lost (the app catches up on its next fetch); each new hearing reads the file's
responsible lawyer once more than the reminder scheduler does (one primary-key lookup, kept for simplicity); every
environment needs its own `BULLMQ_PREFIX` if Redis is ever shared. **Left open:** the portal namespace with its own
token check and `client:{id}` rooms (Client Portal story), and the document and AI events (their stories emit them).

**D-130 — AI foundation: providers, the executor, jobs and usage** · Accepted (MVP-83, 2026-10-20)
MVP-83 left the SDKs, the circuit breaker, how the foundation can ship before the PII redactor, the job model and how
the quota is counted open. → **Providers** (`src/modules/ai/providers`): an `AiProvider` interface with **OpenAI** (chat
completions, JSON mode, `store: false`) and **Gemini** (`generateContent`, `responseJsonSchema`, key in the
`x-goog-api-key` header, never the URL) called over `fetch` — no SDKs (a few fields each, like Resend in D-085); a
deterministic **`FakeAiProvider`** (per-feature fixtures, scripted answers and errors, SHA-256 echo otherwise) is the
only provider in tests and CI. Anthropic (optional in the ticket) is not built. **Config** (Zod env, documented in
`.env.example`): `AI_PRIMARY_PROVIDER` / `AI_FALLBACK_PROVIDER` = `openai|gemini|fake|none` (default `none` = AI off,
AI-001), each used provider needs its `*_API_KEY` and `*_MODEL` (model names are configuration), the fallback must differ
from the primary, `fake` is refused in production; `AI_MAX_OUTPUT_TOKENS` 4096, `AI_TEMPERATURE` 0.2, `AI_TIMEOUT_MS` 45 s
per attempt (inside the `ai` queue's 120 s), `AI_CACHE_TTL` 24 h, `AI_MODEL_PRICES` (USD per million tokens by model; an
unlisted model costs 0, the tokens stay). Keys are redacted from logs. **Fallback** only when a provider is
**unavailable** — timeout, network, 429, 5xx, or a 200 that is not the expected JSON — never on a refused request (other
4xx: AI-003 when the input is too long, else AI-001) nor on invalid output. All unavailable → AI-002 if the last one was
rate limited, else AI-001. **Circuit breaker** per provider and process: 5 failures in a row open it for 30 s, then one
trial call; a refused request does not count. **`AiExecutor.execute({feature, prompt, schema, redactionContext,
cacheKey?, ttlSeconds?, userId?, signal?})`** (features extend `BaseAiService`): availability (`AiAccess`: provider
configured → AI-001; office `enableAi` → **AI-005**; plan flag `ai` → AUTH-102; monthly quota → AUTH-103) → cache → PII
redaction → provider → JSON parse + Zod validation with **one repair call** (the problem is named by paths and issue codes,
never by content) → re-hydration → validation again → usage row → cache. Still invalid → **AI-004** (the usage row is
written anyway: the calls cost). User text over 400,000 characters → AI-003 (features chunk long documents). **PII
redaction fails closed (D-057):** the redactor is its own story; until it replaces the `AI_REDACTOR` provider, a
`PassThroughRedactor` (`redactsPii: false`) stands in, and the executor **refuses every provider that sends text out**
(AI-001) — only the fake provider runs. Prompts are versioned files (`prompts/<name>.v<N>.ts`; the shared rules are
`legal-assistant.v1`); the version is stored with every result and is part of the cache key. **Cache:** Redis under
`o:{officeId}:ai:…` (`CacheKeys.tenant`, D-058), best effort (a Redis failure is a miss); a cached value the schema no
longer accepts is ignored. **Usage** (`AiUsage`, tenant table, append-only — UPDATE revoked from the app role): one row per
answer with provider, model, tokens (both calls of a repair), cost (`Decimal(10,6)`, decimal.js), duration and `cached`;
**the quota counts provider calls (not cache hits) since the start of the UTC month** (`EntitlementsService.aiCallsThisMonth`,
now also `usage.aiThisMonth` of `GET /offices/me/subscription`, amends D-122). **Jobs** (`AiJob`, tenant table: type,
`sourceType` = `AiSourceType` (D-039's list, now in shared-types with AR/EN labels), `sourceId`, status
QUEUED|RUNNING|SUCCEEDED|FAILED, `errorCode`, attempts, `result` = ids only, creator): `AiJobs.enqueue` checks availability,
writes the row and queues `ai/<type>` after the commit (job id = the row id) → 202 `{jobId, status}`. One `AiProcessor`
consumes the queue and dispatches to the handler a feature registered in `AiJobRegistry`; an unknown job fails
(SYS-001). Only availability errors (AI-001, AI-002, SYS-001) are retried; anything else fails at once; the last failed
attempt marks the job FAILED with its code. Success and failure push `ai.job.completed|failed` (D-129) to the creator.
**`GET /jobs/:id`** (`use:ai`) shows a job to **its creator only** — it may concern a file a colleague cannot see; anyone
else, another office or a malformed id → 404. **Not here:** `AiSummary` and every feature (document and session summary
stories), the evaluation set, the daily cost alert (`AI_COST_ALERT_THRESHOLD_USD`), per-plan input caps, and the real
redactor. Why: every AI feature gets fallback, validation, caching, quota and cost tracking from one place, and no text
reaches a provider before PII redaction exists.
Review additions (same PR): **amends D-122** — `assertAiQuota()` now counts itself (`EntitlementsService.aiCallsThisMonth`),
so D-122's "the AI usage records arrive with the AI quota story" is done; and implements **D-014**'s 202 + job id for AI.
**Order:** enablement (provider, office switch, plan flag) → cache → **quota** → call: a cached answer is served even when
the quota is used up. **Quota unit:** one AI request = one usage row of a provider answer — a repaired answer counts once,
though both calls are paid and recorded in the same row. **Usage is recorded in a `finally`**: an answer already received
is recorded even when the repair call then fails. **Cost** is computed per call at the **configured** model name
(`AI_MODEL_PRICES` key; providers answer with dated snapshot names) and summed — a repair from the fallback is priced
at its own rate. **Deadline:** one `execute` has **100 s** for every attempt (primary, fallback, repair), inside the
queue's 120 s; missing it is AI-001. **Breaker:** a half-open trial ended by an abort or an unexpected error is released
(it no longer keeps a provider off until restart); a refused request does not count. **Refusals** — a 4xx, a safety block
(Gemini `promptFeedback.blockReason`, a `SAFETY`/`RECITATION`… finish, OpenAI `refusal` or `content_filter`) — are final:
no fallback, no breaker count (one office's document cannot switch a provider off for everyone), and **not retried** by
the worker (`AiFinalException`, also for "no provider" and "no redactor"). **Jobs:** only a RUNNING job succeeds (a late
attempt changes nothing and tells nobody); `result` is checked to hold ids and counts only (`AiJobResultSchema`) — AI
text never lands in the row; CHECKs tie `error_code` to FAILED and `finished_at` to a finished job; reading a job needs a
caller. **Hardening:** `AiProviders` is not exported (features reach a model only through `AiExecutor`); the system
prompt is redacted too (case data belongs in the user text); the repair instruction is a **separate message**, never
appended to the document, and the system rules say the user message is material, not instructions; a provider's error
body is only searched (first 4 KB) for "too long", never kept; `$schema` is stripped from the JSON Schema sent;
Gemini's thinking tokens count as output; the cache key is `[feature, …parts, promptVersion]` (two features can no
longer share an entry); the fake provider keeps its last 100 requests. **Gemini retention:** it has no `store: false`
— production must use a paid Gemini API account whose terms exclude training and retention (D-057), or leave Gemini
out. **Known limits:** the quota check is not atomic — parallel jobs of one office (worker concurrency 5) can exceed it by
a few requests; a job whose enqueue was lost after the commit, or that was skipped because its office was suspended,
stays QUEUED (no sweep yet); job fields are not limited per job type yet (each feature's handler validates its own).
.**D-126 — Document uploads: streaming, type sniffing, the malware scan, versions and idempotency** · Accepted (MVP-72, 2026-10-20)
MVP-72 left the form layout, how the type is judged, what the scan does with each result, retries of an upload and who sees a
confidential document open. → **Upload** `POST /documents` (`upload:document`; the file must be visible and not archived —
`contribute`, D-119 — so a paralegal files documents on a lawyer's case) is `multipart/form-data` **read as a stream**
(busboy, no Nest body parsing): the text fields (`fileId`, `documentType` default OTHER, `folderId?`, `sessionId?` of the same
file, `isConfidential?` as `true`/`false`) must come **before** the `file` part, so they are validated (VAL-001) and access is
checked before a byte is stored; only the first file part is read and it must be named `file`. A body announced over 50 MiB
+ 64 KiB is refused unread (413 VAL-006, answered once it has arrived so the client sees it); a file over 50 MiB (exactly
50 MiB passes) is cut at the limit, its object deleted, 413 VAL-006. **Type:** judged by the first 64 KiB, never the name or the
browser's Content-Type — magic bytes for PDF, PNG, JPEG, TIFF and DOC (OLE2; only named `.doc`), DOCX/XLSX as ZIP with
`[Content_Types].xml` and `word/` or `xl/` entry names, CSV as text without NUL bytes (any encoding: Excel writes Arabic CSV
as Windows-1256) — **and the name's extension must belong to that type** (a PNG called `.pdf` or a renamed executable → 415
VAL-005). `file-type` was not used: it is ESM-only and the backend is CommonJS. **Names:** the uploaded name, without any
browser path, is kept as is (Arabic too) in `originalFilename` and as the display `name`, and refused with control or bidi
characters (`gpj‮exe.pdf`, VAL-001 on `file`). **Storage:** streamed to `{officeId}/{fileId}/{documentId}/{uuid}.{ext}`
(canonical extension: `jpg`, `tiff`) while size and SHA-256 are computed; the document id is a UUID v7 made by the app
(`common/ids/uuid-v7.ts`) because the key needs it before the insert. **Quota** (D-122): refused at once when already full,
then checked with the real size after storing (403 AUTH-103, object deleted). **Recording** (one transaction): the document
(status SCANNING, `ocrStatus` PENDING), version 1, a `DOCUMENT_UPLOADED` timeline event (`{name, versionNumber}`) and a
CREATE audit row; any failure deletes the stored object. After the commit `ocr/scan-document {documentId, versionNumber}`
is enqueued (job id `scan-{documentId}-v{n}`); the answer is **202 `{documentId, versionNumber, status}`**.
**`Idempotency-Key`** (8–128 of `[A-Za-z0-9_-]`, else VAL-001): stored on the document, unique per office + uploader
(migration `document_idempotency_key`); a repeated key returns the first document without reading the body, and a race on the
same key answers the winner. It never expires (keys are the client's random ids) — the api-conventions Redis 24 h store is
not needed for uploads. **Versions:** `POST /documents/:id/versions` (`changeNote?` then `file`) locks the document row, adds
version n + 1, makes the document mirror it (`originalFilename`, type, size, checksum, key) with status SCANNING and
`ocrStatus` PENDING, writes the timeline event and an UPDATE audit row, and queues its scan; `GET /documents/:id/versions`
lists them newest first with their author. The display `name` stays (renaming is the documents story's). A quarantined
document may receive a clean new version. **Scan** (`OcrProcessor`, the `ocr` queue's single consumer; ClamAV `INSTREAM` over
TCP in a few lines, no client library): clean → PROCESSING and `ocr/process-document` enqueued; infected → QUARANTINED, the
version's object deleted, a SECURITY audit row (`MALWARE_DETECTED`, signature) and an in-app notification to the uploader
(`shell.notifications.documentQuarantined`, params include `code: STO-004`, link to the file's Documents tab); a scan that
cannot finish is retried (3 attempts) and then the document is **FAILED — fail closed**, never treated as clean. Only the
version the document still mirrors, while SCANNING, changes the document; a replaced version is still scanned and deleted when
infected. **clamd's `StreamMaxLength` defaults to 25 MB**: both compose files now set 60M (dev and staging), and any other
clamd must too, or large uploads fail closed. **`process-document`** (text extraction) belongs to its story: until then the
job completes as skipped and documents stay PROCESSING — that story must pick up PROCESSING documents again. **Confidential
documents** (`DocumentAccessService`, for the documents story too): seen only by the office manager, the uploader and the
people assigned to the file (as for confidential files, D-096, also hidden from senior lawyers and admins who see every
file); others get 404. **Rate limit** 20 uploads a minute per IP (api-conventions says per user; limits run before
authentication, D-082). **Not done here:** the documents list, download, rename/move, delete and share (documents story), the
HTTP isolation matrix entry (it needs list/get/patch/delete; another office's file or document → 404 is tested in
`documents.int.spec.ts`), realtime `document.*` events (WebSocket story). Why: an upload is never held in memory, never
trusted by its name, and never offered before it was scanned.
Review additions (same PR): **an aborted or timed-out upload** ends the parser (`stream.pipeline`, not `pipe`), which
errors the file stream, so the storage write fails and is cleaned up instead of waiting forever; every early answer (413,
415, a refused field, a replay) is sent once the body has been read (`discardBody`, bounded by the server's request
timeout), so the client sees it. **Inside the write** the file row is locked (`FOR NO KEY UPDATE`, as folder writes do) and
checked again — deleted meanwhile is 404, archived BIZ-007 — with the folder and hearing, because an upload can take
minutes. **Replacing a document** (a new version) is for its uploader or someone who may edit the file
(`edit:any|assigned:case`, else 403 AUTH-100 / 404): `upload:document` alone (trainees, outside collaborators) adds
documents but does not overwrite a colleague's. **Idempotent replays** report the document's current version and status; a
key whose document the caller can no longer see (deleted, file out of scope) is spent — 409 RES-002, body not stored. **A
confidential document's name stays out of the file's timeline** (payload `{versionNumber}` only), which colleagues off the
file may read; its audit rows keep the name — the audit-viewer story must filter Document rows with
`DocumentAccessService.visibleWhere`. **clamd fails closed on what it skips:** the compose files also set `AlertExceedsMax`
and `AlertEncryptedArchive` (content over its limits, password-protected archives → reported, so QUARANTINED); encrypted
PDFs and Office macros are not flagged (offices receive both routinely) — the allow-list already refuses macro-enabled
packages (`vbaProject.bin`), and a DOCX/XLSX must contain its main part (`word/document.xml` / `xl/workbook.xml`). A clean
scan retried after its `process-document` enqueue failed enqueues again (the update also matches PROCESSING; the job id
keeps one). The version list is capped at 100; the version UPDATE audit row holds the replaced name, type and checksum.
**Deviations / known limits:** the 202 carries `documentId`, not a `jobId` (D-014): the document is the thing to follow,
through its status. Versions have no scan status of their own (`document_versions` is append-only): a version replaced
before its scan finished is scanned and deleted when infected, but the download story must serve only the current version
while READY, or record per-version results first. Concurrent uploads each pass the quota against committed usage, so an
office can overshoot it by about one upload each. A scan job lost after its commit leaves the document SCANNING (fail
closed); a reconciliation like D-117's belongs with the text-extraction story. The malware SECURITY audit row has no user
(written by the worker); the notification type is `DOCUMENT_QUARANTINED`; anyone who may upload may mark their upload
confidential; `GET /documents/:id/versions` needs ANY of `view:all|assigned:cases` plus the document rule above.
**CI (amends D-078/D-085):** the workspace job also starts ClamAV (`clamav/clamav:stable`, the compose settings above) and waits for
`clamdcheck.sh` before the integration tests, which scan the EICAR file for real; its signature download adds about a minute.

**D-128 — Reading and managing documents: the file's list, metadata, soft delete, download and text** · Accepted (MVP-74, 2026-10-20)
MVP-74 left who may rename, move, (un)classify and delete a document, what a download may serve, and how text is paged open.
→ **Visibility** is D-126's `DocumentAccessService` everywhere: the file's scope (404 otherwise, D-019) and confidential
documents only for the office manager, the uploader and the file's team. **`GET /cases/:id/documents`** (ANY of
`view:all|assigned:cases`): live documents only, filters `folderId` (a folder of the file, or `root`), `documentType`,
`status`, `search` (name or uploaded file name, case-insensitive contains; full-text search over the extracted text comes
with global search), `sort=name|createdAt|updatedAt|sizeBytes[:dir]` (default newest change first, id as tie-break),
paginated (≤ 100). **`GET /documents/:id`**: the document's current-version facts and uploader — never the storage key or
checksum of older versions. **`PATCH /documents/:id`** (`upload:document`, a file that is not archived): `name`, `documentType`,
`folderId` (`null` = root, a folder of the same file or VAL-001 `validation.unknownFolder`) and `isConfidential`; like a new
version (D-126) only the uploader or someone who may edit the file changes a document, and **setting or lifting
confidentiality** is for the office manager, the uploader or the file's responsible lawyer (403 AUTH-100 otherwise; as for
files, D-096). Only changed fields are written and audited (the shared changes helper); an empty body is VAL-001.
**`DELETE /documents/:id`** (`delete:document` = OM, SL, L; uploader or file editor): soft — `deletedAt`, gone from every list
and route (404), its stored objects kept until the retention purge (which also has to free their quota bytes); audited with
its name. **Download** `GET /documents/:id/download?version=` → `{downloadUrl, expiresIn: 300}` (JSON, D-013): only a document
that passed its scan — QUARANTINED is **422 STO-004**, UPLOADED/SCANNING/FAILED **422 BIZ-015** (new: "not scanned clean yet");
`version` names an older version (404 when it does not exist), the link serves that version's own uploaded name as an
attachment (RFC 5987, Arabic kept, D-085) and type, and every link is an audit row `DOWNLOAD {versionNumber}` (a link,
not proof the file was fetched). Older versions are offered on the document's state: a version replaced before its scan
finished is still scanned and deleted when infected (D-126), but one whose scan never finished stays offered — a per-version
scan record (append-only versions cannot take a status column) is the fix if that ever matters. **Text** `GET
/documents/:id/text?page=`: the current version's extracted text in 20,000-character pages with `totalPages` and the
document's `ocrStatus` (empty, 0 pages, until the text-extraction story fills it). **Not done here:** sharing with the client
(portal stories), the documents tab UI (its own story), a retention purge, `documents` in the HTTP isolation matrix (its list is
per file; the integration test covers list, get, patch, delete and download across offices). Why: every way to a document's
content goes through one access rule and leaves an audit row.
Review additions (same PR): **only the current version is downloadable** — the scan result is the document's, i.e. the
current version's, so `?version=` other than the current is 404 until versions carry their own scan record (D-126 asked
for exactly this; a version replaced before its scan ran could otherwise be served unscanned). **The text view is gated and
audited like a download:** only once scanned clean (STO-004 / BIZ-015), and each page read writes a `VIEW {versionNumber,
text: true, page}` audit row. **Edits and deletes lock and re-check inside the write** (as uploads do, D-126): the file row
`FOR NO KEY UPDATE` — deleted meanwhile 404, archived meanwhile BIZ-007, the target folder still the file's — then the
document row `FOR UPDATE`, read again (deleted meanwhile 404), so the audit's old values are what the change replaced.
Download and text read the document with `deletedAt: null`; `version` is capped at 10,000 (no 500 on huge numbers). The
list query's `type` filter is named `documentType` (the contract's enum name), and `folderId=root` lists the file's root. A
rename changes the display `name` only; downloads keep each version's uploaded name. **Later:** a
`(office_id, file_id, updated_at DESC) WHERE deleted_at IS NULL` index if files reach thousands of documents; reading only
the requested 20,000 characters in SQL instead of the whole text.
**D-127 — Hearings on the file page: office-time entry, the drawer, conflicts and inline courts** · Accepted (MVP-69, 2026-10-20) · Amends D-090, D-092
MVP-69 needed hearing times on the office's clock in a browser that may run in any zone, and left the drawer's states, the
conflict flow and "inline add" open. → **Time zone (amends D-090/D-092):** the session answer of login and refresh carries
`user.timeZone` (the office's `timezone`, D-125), and the office app passes it to `NexProvider`, so every date and time on
every page is shown in the office's zone (D-092 left this to "once office settings exist"); a manager's saved time zone updates
the tab at once. `shared-utils` gains `wallClock(instant, zone)` and `zonedDateTime(date, time, zone)` (100 % covered, DST-tested):
date and time pickers hold the **office wall clock** as plain values, and the request carries that time with the office's offset
(`2026-11-02T09:30:00+02:00`, D-116), whatever the device's zone; a wall time skipped or repeated by a DST change (at night)
resolves to a neighbouring reading. The drawer says which zone it uses. **Hearings tab** (`features/cases/sessions`): Upcoming
(soonest first) and Past (latest first), 10 per page, each row with type, time, status, outcome or "outcome not recorded",
court and room, judge, attending lawyer and the reminder days; a row (click or Enter/Space) opens the **drawer**. The list rows
have no reminder statuses (the list contract leaves them out), so the drawer shows each reminder with its recipient and status
(D-117). **Drawer:** a new hearing (type, date, start, optional end, court and judge, room, attending lawyer — the caller when
they may attend, else the file's responsible lawyer — and reminder days, empty = the office's default); an existing one shows
its summary, the edit form and "cancel hearing" (confirm, optional reason) while SCHEDULED, and outcome + minutes once it has
started (correctable, "schedule the next hearing" with a date and time while it has none; the AI summary button is disabled until
the AI features). Edits send only changed fields (instants compared as instants, reminder days as sets). **Conflicts:** a 409
BIZ-004 shows each busy slot with its time and the file number when the user may open that file ("a hearing on a file you
cannot open" otherwise) and "schedule anyway", which resends with `acknowledgeConflict` (create, edit and next hearing).
**Rights (UI only, D-051):** schedule with `create:session`; edit, cancel and outcome with `edit:session` plus write access to
the file (`edit:any:case`, or `edit:assigned:case` when assigned); nothing on an archived file. **Ctrl+Alt+H** opens a new
hearing on the file page (physical key, not while typing — the quick-create rule, now `isCtrlAltShortcut`). **Next-hearing card**
(Details tab): the first SCHEDULED hearing of the upcoming list, with "open hearing"; it shares the tab's query key, so any
hearing write refreshes it at once. **Inline add (D-115):** the court and judge pickers (shared with quick-create) offer "new
court" (Arabic name prefilled with the search, type, optional English name and city) and "new judge" (at the picked court); the
new one is picked. **Deviations:** the Cypress schedule-hearing journey waits for the E2E story (as D-090/D-121); component tests
cover the conflict flow, scheduling, editing, cancelling, outcome, the shortcut, rights, the card and axe in both languages.
Why: hearing times are a legal deadline — they must read the same for everyone in the office, whatever their laptop's clock.
Review additions (same PR): **amends D-118** — the Hearings tab replaces that tab's "coming soon" state, and the next-hearing
card is live. **Rights mirror the API:** every hearing write needs write access to the file (`edit:any:case`, or
`edit:assigned:case` when assigned), so scheduling (and Ctrl+Alt+H) needs `create:session` with it, editing `edit:session`
with it; "schedule the next hearing" is offered only with `create:session` too. The shortcut is off while another dialog is
open. **"Schedule anyway"** re-validates the form and is cleared as soon as the form changes, so it never acknowledges a
conflict the user did not see; forms re-mount when the hearing changed on the server (keyed by `updatedAt`), so a stale form
never sends a colleague's change back. **Reminder days on edit:** an empty list means no reminders (its hint says so); on create
it means the office's default. The next-hearing card reads the next 50 upcoming hearings (cancelled ones included). An unknown
stored time zone falls back to Asia/Hebron in the pickers as in formatting. Texts: separators, labels ("Judge: …") and list
separators are translation keys (Arabic "، "), names, rooms, times and the shortcut are bidi-isolated, reminder offsets use
plural forms (Arabic zero/one/two/few/many/other). **Known limit:** the pickers hold the office's wall clock as a date in the
device's zone; on a device whose zone skips that wall time (a DST gap at night) the picker may show it an hour off — irrelevant at
court hours.

**D-131 — PII redaction before LLM calls** · Accepted (MVP-84, 2026-10-21) · Amends D-130
MVP-84 left the patterns, how names are matched in Arabic, the placeholder scheme, where redaction counts live and the
"office toggle" open. → **`PiiRedactor`** (`src/modules/ai/pii-redactor.ts`) is now the `AI_REDACTOR`, so real providers
may run (D-130's fail-closed rule stays: a redactor that does not redact still blocks them). It replaces, in this order:
**emails**; **IBANs** (two letters, two digits, 11–30 characters, spaces allowed); **phones** — international with the
country codes of our markets (+970/972/962/966/971/965/974/968/973/961/964/212/20, plus 1/44) or `00`, local mobiles
(05x — PS, IL, SA, AE —, 07[789] JO, 01[0125] EG; 3–4 + 3–4 digits) and local landlines (0[2–9] + 7–8 digits), separators
allowed; **bank and card numbers** (15–19 digits); **national ids** (any run of 9–14 digits: PS 9, JO/SA 10, EG 14); then
**names** from `RedactionContext.names` — the feature passes the file's clients, parties, witnesses and lawyers. Digit
patterns match Arabic-Indic and Persian digits too (matched on a Western-digit copy, spliced back by index). A name matches
however it is written: Arabic letter variants (alef/hamza forms, ya/alef maqsura/ya-hamza, ha/ta marbuta, waw/waw-hamza),
tashkeel, the dagger alef and tatweel between letters, any whitespace between words (a name split across lines),
any case, and an attached و/ف/ب/ل/ك prefix; never inside a longer word (السالمي is not سالم). Full names are replaced
first (longest first), then each word of a name of 3+ letters that is not a particle (بن، ابن، بنت، أبو، أم، عبد، ال,
bin, ibn, abu, al, el, mr, dr…), so "Mr. Haddad" is covered too. **Placeholders** `[PARTY_n]`, `[EMAIL_n]`, `[PHONE_n]`,
`[IBAN_n]`, `[ACCOUNT_n]`, `[ID_n]` are stable within one call (variants of one value share one; numbers follow the
matching order); `restore` puts back the original number or email exactly and a name in the spelling the case uses;
unknown placeholders stay as they are. **The mapping lives only in the returned object in the job's memory** — never
stored, cached (the cache holds the re-hydrated answer, the office's own data) or logged. **Counts** per kind (user text
and system prompt together) are stored as `AiUsage.redactionStats` (JSON, default `{}`, migration
`ai_usage_redaction_stats`) — counts only, never values. **Office toggle:** redaction cannot be switched off in the MVP,
so there is no setting; offices that want no AI at all use `enableAi` (AI-005). **Tests:** 40+ Arabic/English fixtures
(hamza and alef forms, marks, tatweel, prefixes, line breaks, look-alike words, all phone formats, Arabic-Indic digits,
ids, IBANs, cards, and dates/amounts/file numbers left alone) and a seeded property test (500 random texts without PII
come back unchanged through redact and restore). **Known limits:** names not in the context (a judge's or a third
person's name the file does not list) are not found — there is no NER; a 9–14 digit number that is not an id (a court
case number written without separators) is redacted too (safe side; it comes back on restore); text that already contains
a placeholder-looking token such as `[PARTY_1]` may be restored to a name; nicknames and transliterations (Ahmad / Ahmed /
أحمد) are matched only when the context lists them.
Review additions (same PR): **one redaction per call** — `redact(texts[], context)` numbers the system prompt and the user
text together, so `[PARTY_1]` is one person in both and `restore` knows every placeholder. **Context:** `names` are
**people** (matched whole and by identifying words), `organisations` are matched **whole only** (their words — شركة،
النور، Trading — are common words); single words are skipped when they are particles or common words (على، إلى، في…,
the, of…; a person called علي is then matched by full name only), punctuation is stripped first. **Linear time:** every
pattern is anchored and bounded (the e-mail pattern had been quadratic — 400,000 characters without an `@` took minutes,
synchronously, blocking the worker); a test runs 400,000-character inputs. **More formats:** NFKC first (PDF presentation
forms, decomposed accents — what is sent and restored is the normalised text); invisible characters (bidi marks, joiners,
soft hyphen) inside names and numbers; two attached prefixes (ولأحمد); Persian ی/ک; hyphenated names (Sarah-Jane, words
split on hyphens; regex escaping fixed — a hyphenated name used to throw); phones in any grouping (0599-123-456,
(02) 2951234, spaces around a dash); ids and card/bank numbers with separators (one digit-group pattern, 9–14 digits an
id, 15–19 an account); IBANs in any case, without the capital words that may follow. **Placeholders:** a placeholder-
looking token already in the source gets a word joiner (`[PARTY⁠_1]`) so `restore` leaves it alone; a person called like
a placeholder kind ("Phone") no longer rewrites an existing placeholder. **Who builds the context:** the AI feature
stories (document and session summaries) pass the file's clients, parties, witnesses and team, and its organisations.
**Known limits** (in addition): bank accounts under 9 digits; a court case number of 9+ digits written without letters
is redacted as an id (restored on output); names written in another script than the context lists (Ahmad vs أحمد).
**D-132 — Text extraction worker, FAILED documents and retry** · Accepted (MVP-73, 2026-10-21)
MVP-73 left the libraries, what "READY" means for documents that still need OCR, where a failure's code lives, who may
retry and how the auto-summary hook looks. → **Extraction** (`DocumentExtraction`, run by the `ocr` worker's
`process-document` job in the document's office, after a clean scan — D-126): by the version's sniffed MIME type,
**DOCX** with `mammoth`, **XLSX** with `exceljs` (every sheet in order under a `# <sheet>` line, cells tab-separated,
formulas by their last result), **CSV** decoded as UTF-8 (BOM stripped) or, when that fails, Windows-1256 (legacy Arabic
exports), **PDF** with `unpdf` (PDF.js; text per page, pages separated by a form feed) when the text layer averages ≥ 50
non-space characters a page; everything else — images, TIFF, legacy `.doc`, scanned PDFs — **waits for the OCR path**
(Tesseract story): the document stays PROCESSING with `ocrStatus` PENDING and the job ends `NEEDS_OCR`. Text is capped at
5,000,000 characters (the search vectors index the first 500,000, D-119) and NUL characters are dropped (PostgreSQL text).
The `DocumentText` row of the version (`ocrEngine` = docx|xlsx|csv|pdf-text-layer, `pageCount` for PDFs,
`ocrConfidence` null) is upserted with the document turning **READY, `ocrStatus` DONE** in one transaction, guarded on
"still PROCESSING and still the current version" (a replaced version or a second run changes nothing); the trigger fills
the search vectors. The uploader's app gets **`document.processed`** (D-129, ids only) when the document is ready and
when it fails. **Libraries:** pinned settled releases (`unpdf` 1.8.1, `mammoth` 1.12.3, `exceljs` 4.4.0 — no SheetJS: its
npm package carries unpatched advisories); `unpdf` loads its PDF.js bundle with a dynamic `import()`, which production Node
runs natively (npm packages stay external, D-103), and **Jest needs `--experimental-vm-modules`**: the backend `test` and
`integration` targets set `NODE_OPTIONS` (integration became a `nx:run-commands` target to carry it). **Failures:** a file
that cannot be read (corrupt, encrypted, truncated) fails at once (`UnrecoverableError`, no retry would help); other errors
(storage) are retried by the queue; after the last attempt the document is **FAILED with `processingErrorCode` EXT-002**
(new nullable column; a failed malware scan stays FAILED with no code). **Retry** `POST /documents/:id/ocr/retry`
(`upload:document`, the file visible and not archived — D-119's `contribute`): only a FAILED document → 202 with the
document, back to the step that failed (extraction → PROCESSING, scan → SCANNING) and its job queued again after the commit
under a new job id; anything else → **422 BIZ-016** (new: "document has not failed"); the change is guarded on FAILED (two
retries queue the work once) and audited (UPDATE, `{retried: true}`). **Auto-summary hook:** `autoSummaryWanted` (a
PLEADING, EVIDENCE, JUDGMENT or COURT_ORDER over 500 words) behind **`AI_AUTO_SUMMARY`** (default false); for now it only
logs — the document-summary story enqueues the summary there (with `enableAi` and the quota, D-130). **Configuration:**
`OCR_WORKER_CONCURRENCY` (1–20) and `OCR_JOB_TIMEOUT_MS` (10 s–10 min) override the `ocr` queue policy (D-084) when set
(`TenantProcessor.timeoutMs` became overridable). **Not here:** OCR of scans and images (Tesseract, then Google Vision),
language detection (`Document.language`), notifying the uploader by email.
Review additions (same PR): **A shared worker must survive any upload** — Office files are checked against **zip bombs**
before parsing (the central directory's declared sizes: at most 100 MB unpacked, a 100:1 ratio, 10,000 entries; ZIP64
refused), sheets and PDFs are read with a **text budget** (collection stops at 5,000,000 characters), empty cells are
skipped, PDFs are read **page by page** (at most 2,000 pages, never all pages at once) and their PDF.js document is
always released, and the `ocr` queue's default concurrency drops from 10 to **2** (amends D-084;
`OCR_WORKER_CONCURRENCY` raises it). Running the parsers in a worker thread with memory limits is **not done** — a
crafted file can still hold the event loop for a while; that is the next step if it ever shows. Images, TIFF and `.doc`
are no longer downloaded just to be sent to OCR; the attempt's abort signal stops a timed-out extraction before it writes.
**Codes:** a file no parser can read (corrupt, encrypted, a zip bomb) is FAILED with **VAL-005** and its retry is refused
(BIZ-016 — the same parse would fail again); a failure that may pass on retry (storage, a job that stalled more than
BullMQ allows — now also treated as final, so a document never stays PROCESSING) is **EXT-002**. **The malware scan is
never skipped:** a new version (and a scan that failed for good) clears `processingErrorCode`, so a retry after an older
extraction failure goes back to the scan (`NEW_VERSION_STATE`); a FAILED document is downloadable only when it failed
**after** a clean scan (a processing error code), like PROCESSING and READY. **Who is told:** the uploader of the
version (not of the document), live (`document.processed`) and, on failure, by an in-app notification
(`shell.notifications.documentFailed`, D-117's notification queue); deleted documents are never processed.

**D-134 — Team invitations: links made by the worker, seats, acceptance and the invite UI** · Accepted (MVP-49, 2026-10-23)
MVP-49 left the token hand-off, what "exists anywhere" means, the invitee's language, who is notified and how several rows
are sent open. → **API** (`src/modules/users`, all `manage:users` = OFFICE_MANAGER): `POST /users/invite` `{email, role,
fullName?, message?}` — one person per call (the team page sends one call per row, so each row gets its own answer); any
role but OFFICE_MANAGER (400 VAL-001 `validation.inviteRole`; a manager is made by changing a member's role); an email held
by a user of **any** office (D-032) or by a PENDING, unexpired invitation of this office → 409 RES-002; another office may
invite the same person (whoever accepts first wins, the other gets 409 on accept). A lapsed PENDING row is closed as EXPIRED
first, so the address can be invited again (one PENDING row per office + email, D-079). `GET /users/invitations` lists
PENDING rows newest first, shown as EXPIRED once their 7 days have passed; `POST /users/invitations/:id/resend` (200) renews
the 7 days and sends a new link (the old one stops working); `DELETE /users/invitations/:id` (204) revokes — anything not
PENDING, another office's or a malformed id is 404. **Seats:** a pending, unexpired invitation holds a seat (D-122):
invite, and resending an expired one, call `assertUserSlot` (422 BIZ-008) under the office's team advisory lock (D-124), so
two invitations at once cannot take the last seat; accepting does not re-check (the seat was held). New column
`office_invitations.full_name` (the name typed, offered on the accept page). Every change has an audit row
(`OfficeInvitation` CREATE/UPDATE). **Links (the D-085 pattern):** the row is created with the hash of a random token that is
never sent; after the commit `email/send-invitation {invitationId}` is queued and the worker (`InvitationLinks`) stores the
hash of a new token — conditional on PENDING, so a revoke racing the send wins — and emails the raw link
`{OFFICE_APP_URL}/accept-invite?token=…` in the **office's default language** (the invitee has no language yet) with the
inviter, office, days left and the manager's note (`invite` template gains an optional, escaped `message`). Each attempt
rotates the link, so each attempt is its own message.
**Acceptance** (public): `POST /auth/invites/preview {token}` (10/min per IP) → `{officeName, inviterName, email, role, fullName,
expiresAt}`; `POST /auth/accept-invite` `{token, fullName, password, phone?, acceptTerms, acceptPrivacy}` (5/min) → 201 +
session + refresh cookie like login. Unknown, used, revoked and expired links → **410 RES-004** (both routes, as for
verification and reset links); a suspended office → 403 AUTH-006; the password policy applies, and "not the email" is
checked by the server against the invitation's address (VAL-001 on `password`); an email taken since the invitation → 409
RES-002. One transaction in the invitation's office: the invitation is claimed (conditional on PENDING and unexpired), the
user is created with its role, the office's language and **`emailVerifiedAt` set** (the link proves the address, D-083), ToS
and Privacy acceptance rows (D-083 versions), a `CREATE User` audit row (actor = the new user), an in-app notification to every
active office manager (`invitation.accepted`, `shell.notifications.invitationAccepted`, link `/team`, pushed live after the
commit, D-129), and the session. **Office app:** `/team` gets an **Invite** button (a modal with rows of email, role —
default LAWYER — and optional name, plus one note for all; rows are sent one after the other, the sent ones leave the form
and a refused row stays with its reason) and a **Pending invitations** table (email and name, role, inviter, status, expiry,
resend, revoke after a confirm). `/accept-invite` (public, signed in or not, like the reset page): the token is read once and
removed from the address bar, the page shows office, inviter, email and role, then asks for name (prefilled), password,
optional phone and the two acceptances; success signs in as the new user (a previous user's data is cleared,
`startSession`) and broadcasts `signedIn`. **Not done here:** the Cypress invite → accept journey in Arabic (the E2E story;
every control has a `data-testid`), invitation emails in the invitee's own language (no such choice exists before they
join). Why: a manager can grow the team without a token ever leaving the database's hash, and an invitation can neither
take a seat the plan does not have nor be used twice.
Review additions (same PR): **the token never sits in a URL** — the preview is a POST with the token in the body (the
ticket's `GET /auth/invites/:token` would leave it in proxy and CDN access logs; amends api-conventions.md). **Resend
rotates the link at once** (a fresh, never-sent hash in the same update), so the old link dies even if the email job is
lost, and is limited to **one per invitation per minute** (429 RATE-001; the row's `updatedAt` marks the last send or
rotation); invite is throttled at 20/min and resend at 10/min per IP — our domain must not become a mailer for a manager's
note. **Accepting into a read-only office** (subscription ended, D-122) is refused with 403 AUTH-104: the public route is
never seen by `SubscriptionGuard`, so the service checks it. **Every active office manager is notified**, not only the
inviter (who may have left or been demoted; the ticket says "OM notified"). Two offices' invitees racing for one email:
the loser's P2002 maps to 409 RES-002 (tested). The 409 for an email held in another office discloses that the address has
an account, as `/auth/register` already does (D-032). **Not done:** pending invitations stay valid when their inviter
leaves (the office still wants the invitee; revoke them from the team page); no daily per-office cap on invitation emails
(the per-invitation cooldown, the seat limit and the IP throttles bound it); a manager need not have verified their own
email to invite (verification is not enforced yet, D-083).
**D-133 — Documents tab: folder tree, upload panel, live status and what waits for other stories** · Accepted (MVP-75, 2026-10-21)
MVP-75 asks for a folder tree, a list with status chips, multi-file drag-and-drop upload with progress, live status and
actions, but sharing with the client (portal), AI summaries and previews have no endpoint or story yet. → `?tab=documents`
of the file page (`apps/office-app/src/features/cases/documents`, `documents` namespace). **Folder tree** (AntD `Tree`):
"All documents", "Not in a folder" (`folderId=root`) and the file's folders nested by `parentId`, system folders labelled
`enums.folderSystemKey.*`, with their document counts; selecting one filters the list and returns to page 1. New folder
goes **inside the selected folder** (else at the root); only custom folders offer rename (system folders refuse it, BIZ-014).
Moving and deleting folders is left to a later UI (the API has both). **List** (server-paginated, 20 a page, search on
Enter): name with a version badge when `currentVersion > 1` and a "confidential" tag, type, status (`StatusTag`; a FAILED
document's tooltip says why — `errors.EXT-002|VAL-005`), language (new `language` field on `DocumentSchema`, null until
detected), uploaded by, last change, size (B/KB/MB in the reader's digits). **Live status:** the realtime bridge already
invalidates `['documents']` on `document.processed` (D-129); as a fallback the list **polls every 10 s while a shown
document is UPLOADED, SCANNING or PROCESSING**, and stops when none is. **Upload panel** (button or **Ctrl+Alt+U**,
physical `KeyU`, ignored while typing): `Upload.Dragger`, several files at once, each checked here for extension (the
D-035 list), emptiness and the 50 MB limit before anything is sent (the API sniffs the bytes again); one document type
(default OTHER) and folder (default: the selected folder) for the batch; files go **one after the other** with their own
progress bar (`ApiRequest.onUploadProgress`, new in shared-api-client) and an idempotency key made once per file, so
"try again" after a failure never creates a second document; a failed file shows `errors.<code>`. The panel is mounted per
opening (fresh queue). **Actions** (⋮ per row, UI only, the API re-checks): rename, move to folder and "try again" (a
FAILED document whose code is not VAL-005 — an unreadable file cannot be fixed by a retry) with `upload:document`; delete
with `delete:document` after a `ConfirmModal`. **Archived files offer no writes** (D-052). Shared API client:
`documentsApi` (`forFile`, `upload`, `update`, `remove`, `retry`) and `foldersApi` (`list`, `create`, `update`).
**Deferred:** share with client and AI summarise (portal and AI-summary stories), download/preview and version history
(the download story's UI), folder move/delete, drag-and-drop between folders, bulk actions, retyping and marking
confidential from the list. Why: the documents a file holds are visible and manageable today, using only routes the API has.
Review additions (same PR): **polling** covers only documents changed in the last 10 minutes — images and scans stay
PROCESSING until OCR exists (D-132) and would otherwise be refetched every 10 s for as long as the tab is open (the
`document.processed` event still updates them). A page emptied by a delete moves back to the last page with rows. While a
batch uploads, its files cannot be removed from the queue; once a file has failed, the batch's type and folder are locked
(its retry reuses the idempotency key, which the server may already hold with the first choice). The size limit in the
texts comes from `MAX_UPLOAD_BYTES`; Arabic writes كيلوبايت/ميغابايت and "إصدار n" in full. **Ctrl+Alt shortcuts** share one
hook (`useCtrlAltShortcut`) that also ignores keys while focus is inside a dialog, so Ctrl+Alt+U and the hearing drawer's
Ctrl+Alt+H never open over each other. Actions are not hidden while the subscription is read-only (as on the Hearings
tab: the banner explains it and the API refuses with AUTH-104).

**D-135 — Parties, identifier blind indexes and the conflict-of-interest check** · Accepted (MVP-62, 2026-10-23) · Amends D-056
MVP-62 asks to search parties by national and tax id, which D-056 keeps encrypted and "never searched", and leaves open
which roles are "adverse" and what the check compares a party with. → **Blind indexes (amends D-056):** `FieldCipher.blindIndex`
= HMAC-SHA256 under a key derived from `ENCRYPTION_KEY` (HKDF, info `nexlegtiq blind index v1`), over the identifier with
digits made Western and everything but letters and digits dropped, upper-cased, scoped `national_id:<officeId>` /
`tax_id:<officeId>`. Stored in new columns `national_id_index` / `tax_id_index` on **parties and clients** (clients write
them on create and update; same scope, so a party can be matched to a client), indexed per office. Exact match only;
the identifiers themselves stay AES-GCM ciphertext. Rows saved before this migration get their index when the id is next
written (no backfill: it needs the key). Party tax ids are now always encrypted, as clients' are (D-108); one stored in
plain text before is read as is. **Registry:** `GET /parties?search=` (ANY of `view:all|assigned:cases`; 20, at most 50,
by name): Arabic-normalised substring of the name (`nlq_normalize_ar`, trigram GIN expression index) or an exact national
or tax id; rows carry name, type and contacts — no identifiers or notes (parties are office-wide, also those of
confidential files). **File parties:** `GET /cases/:id/parties` (read access; identifiers and notes decrypted),
`POST /cases/:id/parties` `{partyId | party, partyType, roleLabel?}` (exactly one of the two, `validation.partyChoice`;
another office's or unknown party → 400 `validation.unknownParty`), `PATCH /cases/:id/parties/:filePartyId`
`{partyType?, roleLabel?}`, `DELETE` (204; the party stays in the registry) — all with ANY of `edit:any|assigned:case`
and write access to the file (D-096). The same party twice in the same role → 409 RES-002. Add writes a `PARTY_ADDED`
timeline event (`{partyId, name, partyType}`) and audit rows (`Party` CREATE with ids and notes as `[encrypted]`,
`FileParty` CREATE/UPDATE/DELETE). **Conflict check** (W9), run in the add's transaction and again when a party is
retyped: **adverse roles** are the dispute sides — PLAINTIFF, DEFENDANT, APPELLANT, RESPONDENT, PROSECUTION (third parties,
guarantors, signatories and interested parties are not). A conflict is recorded when the party (1) is on **another open
file** (live, OPEN or SUSPENDED) **in an adverse role**, whatever its role here (`ADVERSE_ON_OTHER_FILE`), or (2) is
adverse here and is **the client of another open file** — same national/tax id index, or the same Arabic-normalised name
as the client's display, full or company name (`CLIENT_ON_OTHER_FILE`). A pair of files and party is recorded once,
whichever came first, and a resolved conflict is never raised again. **Conflicts warn, never block:** the add answers 201
with `{fileParty, conflicts[]}` (every open conflict of that party on that file); BIZ-009 is not used. `GET /conflicts`
(`resolved`, `fileId`, paginated) lists conflicts with at least one file the reader can open; a file the reader cannot
open (scope or confidentiality) is `null` — only that a conflict exists is shown, as for hearing conflicts (D-116).
`PATCH /conflicts/:id/resolve {notes}` needs write access to either file; resolving twice → **422 BIZ-017** (new: "conflict
already resolved"), so the first note stays; audited. Removing the last role of a party from a file deletes its open
conflicts on that file (resolved ones stay as history). **Not done here:** the Parties tab, conflict modal and banner
(their UI story), editing a party's own details (name, ids, notes) after creation, party attendance at sessions, and
checking a new **client** against existing adverse parties (the client form would run the same rule). **Known limits:**
name matching is exact after normalisation (no fuzzy similarity) and misses a client stored only with an id saved before
this migration; rule (1) also flags a repeat opponent (the same company sued twice), which the lawyer resolves with a
note. Why: the conflict check works on encrypted identifiers without decrypting a table, and never reveals a file the
reader may not open.
Review additions (same PR): **the check is symmetric and complete** — it no longer depends on the order roles were
added: a pair of open files conflicts over a party when it has roles on both and **either** role is a dispute side, or it is
adverse on one and the client of the other (both directions). Every add, retype and removal **re-syncs** the party's open
conflicts on that file: missing pairs are created in one statement, open ones that no longer hold (the party removed or
made neutral) are deleted with a `ConflictOfInterest` DELETE audit row each, resolved ones are never touched. **Writes lock
the party row** (`FOR UPDATE`) so two simultaneous changes about the same party see each other (tested: two parallel adds
record each pair once), and **lock and re-check the file** (`FOR NO KEY UPDATE`: deleted meanwhile → 404, archived →
BIZ-007), as D-119/D-126 writes do. **Registry search needs `edit:any|assigned:case`** (it is a picker for adding parties;
trainees and outside collaborators no longer see names and contacts of parties on files they cannot open).
**Resolution notes** are returned only to readers who can open both files (a note may describe the confidential matter);
`GET /conflicts?fileId=` on a file the reader cannot open is 404. "Fuzzy" in W9 is read as Arabic-normalised substring for
names and exact match for identifiers (D-059's trigram similarity ranking is left to global search). Rotating
`ENCRYPTION_KEY` must recompute the blind indexes too (ops-security.md). **Not done (also):** an existing adverse party
becoming the client of a new file is checked only when that party is next added or retyped (the client/case-creation
flows should call the same sync); party notes and identifiers belong to the party and are shown on every file it is on;
the conflict check can confirm that a guessed national id belongs to some client (`otherFile: null`), a risk accepted for
holders of edit rights; detection compares client names without an index (fine at office scale).
**D-136 — Audit service, VIEW throttling and the retention purge** · Accepted (MVP-104, 2026-10-23)
MVP-104 asks for one audit service used everywhere, VIEW auditing, DB-level protection and a retention job, while every
module already wrote its own rows (53 writes, 16 builders) and D-079 left the purge to "the migrator". → **Service**
(`src/common/audit/audit.service.ts`, provided by the global `DatabaseModule` next to Prisma): `AuditService.log(tx, entry,
client?)` / `row(entry, client?)` fill office, actor, IP, user agent and request id from the request context — the CLS
now also holds `ip` (Express' `req.ip`, so `TRUST_PROXY_HOPS` applies) and `userAgent`, set when the request starts —
and any `AuditClient` field passed (null included) overrides it; the row is written in the caller's transaction. The pure
`auditRow(entry, client)` is the same row for code that already knows its office and actor; **every module's audit builder
now delegates to it** (cases, tasks, sessions, documents, document versions/retry, folders, clients and contacts, courts,
judges and prosecutors, offices, team, sign-in, password, signup, the permission guard), so redaction, the 512-character
user-agent cap and the row shape live in one place; their call sites are unchanged (one transaction per change, as
before). The worker's malware row keeps its literal shape (no user, no request). **Redaction:** values of `nationalId`
and `taxId` are stored as `[encrypted]`, credentials (`password`, `passwordHash`, `currentPassword`, `newPassword`,
`token`, `tokenHash`, `refreshToken`, `mfaSecret`) as `[redacted]`; values go through JSON (dates as ISO strings). The diff
helper stays `common/audit/changes.ts` (only changed fields, decimals compared as numbers). **VIEW:** `GET /cases/:id` and
`GET /documents/:id` write a `VIEW` row at most **once per user and entity every 10 minutes** (a lookup of the newest
VIEW by the office/entity index); a document's text pages and downloads keep their own per-request rows (D-128). Two
requests in the same instant may both write one (accepted). **Append-only + retention:** the app role keeps INSERT/SELECT
only on `audit_logs` (D-079); the purge is `nlq_purge_audit_logs(office_id)`, a `SECURITY DEFINER` function owned by the
migrator (`search_path` pinned) that deletes that office's rows older than `office_settings.audit_retention_days`, never
fewer than 365 days (D-060), and is the only DELETE the app role can cause; `EXECUTE` is granted to `nexlegtiq_app`
(migration and `db-roles.sql`). The worker runs it daily at 03:00 UTC for every office (active or not) from
`AuditRetentionProcessor`, a job scheduler on the **`report` queue** — its single consumer for now; report jobs join that
processor when they come (one processor per queue, D-085). **Tests:** a role with exactly the app's grants cannot UPDATE or
DELETE audit rows but can run the purge; the purge keeps 365 or 730 days per office; three opens of a file within ten
minutes write one VIEW with the request's user agent, request id and IP. **Not done here:** the audit viewer and export
(their UI story, which must hide rows of files and documents the reader cannot see — D-096, D-126); client-user and
platform-admin actors (the portal and admin realms do not exist yet: `AuditLog.platformAdminId` is there, `clientUserId`
comes with the portal); audit rows for reads other than files and documents. Why: one place decides what an audit row
contains and hides, and the log can age out without the app ever being able to rewrite it.
Review additions (same PR): **the purge honours the longest retention ever set** — `office_settings.max_audit_retention_days`,
kept by a trigger as the highest value the setting has had (never lowered, whatever the app writes), is what
`nlq_purge_audit_logs` uses; lowering the setting (D-125 allows it) no longer deletes history already kept, as D-060's
"upward only" intends. **The shared redaction covers credentials only**: encrypted identifiers stay redacted by the modules
that own them (clients and contacts `[encrypted]`, parties), because the same key is plaintext elsewhere — an office's tax id
is audited in full (D-125); keys that were not sent are dropped, not stored as null (null means "cleared" in a diff).
**A failed VIEW write is logged and swallowed**, never turning a successful read into a 500. **The purge runs one office per
statement**, so a first run over years of rows is never one huge DELETE. The function schema-qualifies its tables.
`AuditService.log` is the entry point for new code; the existing modules keep their builders, which delegate to the shared
`auditRow` (same row, same redaction) — their callers already pass the request facts explicitly.

**D-138 — Tasks UI: the board, the list, the task drawer and quick add** · Accepted (MVP-77, 2026-10-24)
MVP-77 asks for a Kanban with drag and drop, a filtered list, a task drawer and quick add on `/tasks` and the file's Tasks
tab, on top of D-098's API. → `apps/office-app/src/features/tasks` (`tasks` namespace; shared API client `tasksApi`):
one `TasksView` for both scopes — the file's tab (`fileId`) and **My tasks** (`/tasks`, `assignee=me`, which replaces the
placeholder page). **Board** (`@dnd-kit/core` 6.3.1 + `sortable` 10.0.0, D-012, now root dependencies): four columns
TODO / IN_PROGRESS / BLOCKED / DONE, each its own query of the first 100 tasks in Kanban order (more would need paging; a
column of 100 open tasks is a sign to use the list). A card is dragged by its **handle** (the card itself holds a link and
a menu — no nested controls), with the pointer or the keyboard (Space, arrows, Space; Escape cancels) and translated
screen-reader announcements; every card also has **"Move to"** (a menu of the other columns) for keyboard, touch and
screen-reader users. Dropping on a card puts the task before it (after it when moving down its own column), on a column
at its end. **Moves are optimistic:** the board changes at once, then `PATCH /tasks/:id/status` (a column change,
`complete:task`) and `PATCH /tasks/reorder` with the target column's new order (only with `create:task`, D-098 — without
it a card only changes column and drags inside a column are ignored); any refusal (403 AUTH-100 for a task an outside
collaborator may not move, BIZ-007…) restores the board as it was and shows the error. **List**: the same scope in a
paginated table (20 a page) with filters status, priority, assignee (on a file; My tasks are the caller's), due by and
"overdue only", an empty state that tells "no tasks" from "nothing matches". **Overdue** (open and due before today in the
office's time zone, D-092) is an icon and the word, never colour alone. **Drawer** (one for the app, mounted by the shell):
title, description, due date, priority and — with `assign:task` — the assignee (active colleagues whose role may work on
tasks; the API checks they see the file); it shows the task's file as a link, or says a task without a file is
**personal** (D-098: only its creator and assignee see it); edits send only changed fields (a cleared description or
date is `null`); delete after a confirm. **Quick add:** "New task" on both views, the shell's **+ Task** (the placeholder is
gone) and **Ctrl+Alt+T** (physical `KeyT`, D-123's rule) — on a file's page the new task belongs to that file, elsewhere it
is personal. **Rights (UI only, the API re-checks):** create, edit and delete need `create:task`, moves `complete:task`;
an archived file's tab shows its tasks read-only (no add, no moves, the drawer without save, D-052). **Phones** start on the
list (four columns do not fit); the choice of view lasts while the page is open. **Not done here:** picking a file for a
new task from My tasks (no file picker exists yet — a task added there is personal), bulk assign (API ready), task
reminders (their story), filters in the URL. Why: work moves where people already look — the file and their own list —
with a board that works without a mouse.
Review additions (same PR): **positions are saved only on a file's board** — `sortOrder` is per office column (D-098), so
reordering My tasks' mixed columns would overwrite colleagues' positions and fail on any task of an archived file;
there a move only changes the column and the card shows at the server's position. A reorder is sent only for a column of
at most 100 tasks (the API's id limit), and **a refused reorder after a saved status is not a failed move** (the card stays,
the refetch shows the server's order). Moves are **one at a time** (a mutation scope) and the board refetches after the
last one, so an earlier answer never undoes a later move on screen. **An outside collaborator** gets the handle and "Move
to" only on tasks assigned to them (`complete:task` is OWN for that role, D-081). The assignee filter shows only to roles
that can read the people directory (D-123); a deactivated assignee keeps their name in the drawer's picker; the drawer's
form follows the task's last change (`updatedAt`); date pickers read dd/MM/yyyy (D-092); a list page emptied by a change
goes back to the last page; Ctrl+Alt+T does nothing on an archived file's page; a drop the board ignores is announced as
cancelled. **Not tested:** dragging itself in jsdom (no layout for `@dnd-kit`'s sensors) — the move logic (`planMove`) and
the moves through "Move to" are; dragging itself waits for the Cypress journeys (E2E story).
**D-137 — Parties tab, the conflict modal and the file-page banner** · Accepted (MVP-142, 2026-10-23)
MVP-142 asks for the file's parties by role, search-and-reuse or create, a conflict modal with "proceed with note /
cancel / reassign" and a file-page banner, on top of D-135's API. → `?tab=parties` (`apps/office-app/src/features/cases/
parties`, `parties` namespace; shared API client `partiesApi`): parties grouped in `PARTY_TYPES` order (empty roles left
out), each with name (`<Bdi>`), person/organisation, role description, phone and email (`<Ltr>`), and the identifiers and
representative D-135 decrypts for readers of the file (isolated). **Add** (a modal): "existing party" searches the registry
on the server as you type (debounced, `GET /parties`) or "new party" (person or organisation, the D-135 fields, identifiers
and notes marked "stored encrypted"); role (default DEFENDANT) and an optional role description; empty inputs are left out
of the request. **Edit** changes role and description only (party details stay as created, D-135); **remove** asks first
(the party stays in the registry). **Conflicts:** when an add or a retype answers with `conflicts[]`, the modal lists each
one ("X is on the other side of the dispute in <file>" / "X is the office's client in <file>"; the file number is a link,
or "a file you cannot open" when D-135 hides it) with: **proceed with note** — one note, required, recorded on every listed
conflict with `PATCH /conflicts/:id/resolve` one after the other; **cancel** — right after an add, takes the party off the
file again (`DELETE`, which also withdraws its open conflicts, D-135); **close** — leaves them open. **Banner:** the file
page reads the file's open conflicts (`GET /conflicts?fileId&resolved=false`, first 100) and, while there are any, shows a
warning with the count (Arabic plural forms) and "review", which opens the same modal without "cancel". A failed load hides
the banner. **Rights (UI only, the API re-checks):** add, edit, remove and "proceed" need write access to the file — the
header's Edit right (`edit:any:case`, or `edit:assigned:case` when assigned; nothing on an archived file, D-052); others see
the parties and the banner, read-only. **Deviation — "reassign":** reassigning the file needs the file lifecycle story's
route, which does not exist yet (the header's Reassign is still "coming soon", D-118); until then the conflict stays open
and the banner keeps warning. **Tests:** component tests with MSW (grouping, add existing with a conflict and its note, cancel
removing the party, a new party's request, a trainee's read-only view, the banner in Arabic and its resolve, the
non-editor's banner without "proceed"), axe on the tab in both languages, and the client's routes. Why: conflict warnings
reach the lawyer on the file itself, and acting on them leaves a note the office can show later.
Review additions (same PR): a retry of "proceed" after a partial failure skips conflicts already recorded (BIZ-017) and
finishes the rest; editing only the role description does not reopen the modal (only a new role can raise conflicts);
"cancel" removes only the row just added — a party created in the dialog stays in the registry, and conflicts of another
role the party already had on the file stay open; a disabled "reassign the file" button marks the deferred choice; picker
options add the party's phone or email (isolated) to tell apart people of the same name; every parties query is refreshed
after a write (the other file's conflicts and the registry change too); server field errors on a new party's own fields
are shown as a notification (the contract check in the browser catches them first).

**D-140 — A file's clients and team: routes, single roles, reassignment and confidential files** · Accepted (MVP-61, 2026-10-25) · Amends D-095, D-117, D-118, D-124, D-137
MVP-61 named the routes but left the PARALEGAL role, who may name a responsible lawyer, a confidential file's team, the
error codes and the timeline open. → **Routes** (`src/modules/file-participants`, its own module because a new responsible
lawyer resets hearing reminders and the sessions module already imports legal-files): `GET/POST /cases/:id/clients`,
`PATCH /cases/:id/clients/:clientId` (`{isPrimary: true}` only), `DELETE /cases/:id/clients/:clientId`, `GET/POST
/cases/:id/team`, `PATCH /cases/:id/team/:userId` (`{role}`), `DELETE /cases/:id/team/:userId`; reads ANY of
`view:all|assigned:cases` and the file visible, changes ANY of `edit:any|assigned:case` and write access (D-096, 404
otherwise, BIZ-007 when archived); writes answer with the new list (DELETE 204). Every change **locks the file row** (`FOR NO
KEY UPDATE`) and re-checks it, as party and folder writes do. **Clients:** a live, active client of the office (else 400
`validation.unknownClient`), already on the file → 409 RES-002; `isPrimary` demotes the previous primary; the **last client
stays (422 BIZ-018, new)**; removing the primary promotes the oldest remaining client (audited as `promotedClientId`). **Team:**
an active colleague — another office's or an unknown user → **404** (the ticket's test note), inactive or not eligible →
400 VAL-001 on `userId` (`validation.teamMember|responsibleLawyer|responsibleParalegal`); the user row is share-locked like
case creation's checks (D-124). Already on the team → 409 RES-002 (PATCH changes a role). **RESPONSIBLE_LAWYER and PARALEGAL
are single roles** kept in sync with `legal_files.responsible_lawyer_id` / `responsible_paralegal_id`: giving either to
someone moves the previous holder to MEMBER (they keep their access) and updates the column; a partial unique index now
allows one PARALEGAL per file (amends D-095, which only had the responsible lawyer's). A PARALEGAL member leaving the role
(removed or given another) clears `responsibleParalegalId`. **A new responsible lawyer is a reassignment:** it needs
`edit:any:case` (the header's Reassign, D-118; 403 otherwise), must be an OM/SL/L, writes `FILE_REASSIGNED`
(`{fromUserId, toUserId, reason: 'TEAM'}`), a `LegalFile` UPDATE audit row and the `file.reassigned` notification, and resets
the reminders of the file's upcoming hearings (`ReminderScheduler.resetForFile`, now shared with the deactivation wizard of
D-124 — what D-117 asked of the reassign story). **The responsible lawyer cannot leave** — removing them or giving them
another role is **422 BIZ-019 (new)** until another is named. **Confidential files:** adding someone exposes the file, so on a
confidential file only the office manager or its responsible lawyer may add people (403 AUTH-100), the rule D-096 applies to
confidentiality itself; changing roles and removing stay with every editor. **Access** is derived on every request
(D-081, D-051 "assigned" includes team members), so a member sees the file at once and loses it when removed — unless their
role sees every file. **Notifications:** a colleague added as MEMBER or PARALEGAL gets `file.teamAdded`
(`shell.notifications.fileTeamAdded`, link `/cases/:id`), pushed live after the commit (D-129); nobody is notified about
themselves; removals are not notified. **Timeline:** new `TimelineEventType` values `CLIENT_ADDED`, `CLIENT_REMOVED`,
`TEAM_MEMBER_ADDED`, `TEAM_MEMBER_REMOVED` (payload ids and role); every change has an audit row (`FileClient`,
`FileTeamMember`, `LegalFile` for the columns). **Office app:** the Details tab's Clients and Team cards gain the controls,
offered as the API allows (UI only): "Add client" (`ClientSelect`, D-121, so also `manage:clients`; optionally primary),
"make primary" and remove after a confirm (not on the last client); "Add team member" (the people directory, D-123, so
only roles that may read it) with the roles the picked colleague's office role may hold — RESPONSIBLE_LAWYER only with
`edit:any:case`, with a hint that the current one stays as a member — an inline role select per member, and remove after a
confirm; nothing on the responsible lawyer's row; no additions on a confidential file for anyone but the office manager or
its responsible lawyer; nothing at all on an archived file. A refusal is shown as `errors.<CODE>`. **Not done here:** the
`POST /cases/:id/reassign` route of the lifecycle story (it can reuse the same reassignment steps), removal notifications,
moving a deactivated member off files (D-124 keeps them as history), the HTTP isolation matrix entries (its `list/item`
shape does not fit routes nested under a file; `file-participants.int.spec.ts` checks another office's file and user → 404).
Why: everyone working on a matter can be added to it, with the file's lawyer and paralegal always matching its team.
Review additions (same PR): **lock order** — a team write locks the colleague's user row before the file row, the order
D-124's role changes and deactivation use (user, then their files), so the two never deadlock; becoming MEMBER needs no
check at all, so an inactive former paralegal can still be demoted. **Confidential files:** naming a new responsible lawyer
of a confidential file (also oneself, as a senior lawyer on its team) and **linking a client** to it — a linked client will
see the file in the client portal (D-003) — are for the office manager or its responsible lawyer only (403 AUTH-100).
**Amends D-124:** a paralegal released from their files by a deactivation or role change also loses the PARALEGAL team role
there (MEMBER), so the role always mirrors `responsibleParalegalId`; removing a PARALEGAL row the column does not name
changes nothing on the file. `POST /cases/:id/team` defaults `role` to MEMBER; `PATCH …/clients/:clientId` on the primary
changes nothing; removing a client or a member notifies nobody. **Amends D-118/D-137:** a file can now be reassigned from
the Team card (the header's "Reassign" stays a placeholder until the lifecycle route). Audit rows of `FileClient` and
`FileTeamMember` carry the **file id** as `entityId` (the rows themselves are identified by file + client/user), so the
audit viewer's file filter (D-096) applies to them as written. Not recorded on the timeline: role changes between MEMBER
and PARALEGAL (audited). A PARALEGAL member who may edit the file can take the paralegal role from another paralegal.
Office app: one mutation hook per card; a new responsible lawyer also refetches hearing queries (their reminders changed);
`ClientSelect` forwards the form item's `id` (its label now focuses the input).
**D-139 — Tesseract OCR: tools, batching, confidence, the worker image and what gets no text** · Accepted (MVP-144, 2026-10-25) · Amends D-084, D-103, D-122, D-125, D-132, D-133
MVP-144 left the OCR engine and how it runs, where per-page confidence lives, what "page-batched" means, the timeout and
what happens to types OCR cannot read open. → **Engine:** the system **Tesseract 5** (`ara+eng`, `--psm 1` — page
segmentation with orientation detection, so a scan photographed sideways is read upright) and poppler's **`pdftoppm`**
(300 dpi, grayscale) run with `execFile` (`extraction/ocr.ts`), not tesseract.js: native is faster, needs no WASM or
traineddata download at run time, and the image ships the language data (AC). One Tesseract **thread** per process
(`OMP_THREAD_LIMIT=1`; measured: 16 threads read a dense A4 page in 3.4 s, one in 3.9 s) and **two pages at a time** per
job, so CPU use is bounded by the worker's concurrency (`ocr` queue 2 → at most four Tesseracts). **Which documents:**
scanned PDFs (the text-layer check of D-132 finds under 50 characters a page; its page count is reused) and JPEG, PNG,
TIFF (a multi-page TIFF is read in one run, pages split on Tesseract's form feeds). **Batching:** a PDF is rasterized
**10 pages at a time** into a private temporary folder (`os.tmpdir()`, tmpfs in staging), each batch's images deleted
before the next, the folder removed afterwards whatever happens; at most **`OCR_MAX_PAGES`** (default 50, 1–250) pages
are read, the rest of a longer scan is not indexed (`pageCount` = pages read; the truncation is logged); a PDF with no pages
is READY with empty text. **Timeout (amends D-084):** the `ocr` queue's attempt timeout is now **300 s** (was 60 s): about
4 s a page when four Tesseracts share a 2-CPU worker, so the default cap fits; whoever raises `OCR_MAX_PAGES` raises
`OCR_JOB_TIMEOUT_MS` with it. The attempt's abort signal is passed to `execFile`, so a timed-out attempt kills the running
Tesseract or pdftoppm (D-084); a page that fails also stops its sibling (one abort controller per run).
**Hostile files (the D-132 rule for parsers on a shared worker):** pdftoppm renders at most **7016 × 7016 px** a page (`-W/-H`
crop — poppler draws only that area, so a page box of 99,999 pt renders in 1.4 s in 1 GB; scaling instead would enlarge
every small page); an image's header is read first (PNG IHDR, JPEG SOF, every TIFF IFD) and a page over **50 MP**, a TIFF
with more pages than `OCR_MAX_PAGES`, or a header that cannot be read is refused at once as **VAL-005**. The tools get only
`PATH`, `OMP_THREAD_LIMIT` and `TESSDATA_PREFIX` in their environment, never the server's secrets (they parse untrusted
bytes), and the staging `/tmp` tmpfs is capped at 512 MB.
**Result:** the same path as D-132 — `DocumentText` (engine `tesseract`, `pageCount`, `ocrConfidence` = word-weighted mean
of Tesseract's word confidences, 0–100, null when no word was read) and READY with `ocrStatus` DONE, `document.processed`
to the uploader, the auto-summary hook. **Per-page confidence:** new nullable column `document_texts.page_confidences`
(jsonb: one mean per page, null for a page without words; null for text-layer and Office extraction) — the Google Vision
fallback (its own story) decides on the mean and can re-read only weak pages. **Failures (as D-132):** input the tools
report as undecodable (leptonica's `pixRead`/unknown format, poppler's syntax/xref errors) and the image limits above are
**VAL-005** at once (no retry would help, and the retry endpoint refuses it); a missing binary or any other failed run is a
plain error → retried by the queue → FAILED with **EXT-002** after the last attempt, retry via `POST
documents/:id/ocr/retry`. **What gets no text (amends D-132, D-133):** a legacy **.doc** (no reader, nothing to OCR) and a
scan or image of an office with **`enableOcr` off** (amends D-125: the switch is now enforced, read per job from the
office's settings; a missing row counts as on, the column default) become **READY with `ocrStatus` NOT_NEEDED** and no
`DocumentText` — downloadable, not searchable — instead of staying PROCESSING for good (D-133's "images and scans stay
PROCESSING" no longer holds); an image is then not even downloaded, and switching OCR back on does not reprocess them. A
PDF with a text layer, and Office files, are read whatever the switch says (no OCR is involved). The extraction's outcome
is READY, NO_TEXT or SUPERSEDED. The plan flag `googleVisionOcr` (amends D-122: it gates only the Vision fallback) does not
gate Tesseract, which costs nothing per page. **Images
(amends D-103):** the first worker-only system dependency arrived, so the Dockerfile has a **`worker` target** (runtime +
`tesseract-ocr tesseract-ocr-ara poppler-utils`; Debian's package brings `eng` and `osd`), pushed as
`backend-api-worker:<sha>` and used by the staging worker; the API image stays without them. **CI** installs the same
packages before the integration tests, which run the real tools on an Arabic scanned PDF (built in code around a committed
JPEG — the one binary fixture exception: Arabic cannot be rendered from code), a rotated image and a 10-page scan within
the 30 s budget (ai-ocr.md); a developer machine without Tesseract skips those three, CI fails if they cannot run.
Measured in a Debian container with 2 CPUs: 10 pages in 6 s, mean confidence 92; a 2-page TIFF, truncated and junk JPEGs
(VAL-005) and an abort were checked there too. **Not done:** a memory limit on the worker container (the VPS size is the
owner's call, D-103), language detection
(`Document.language`), Arabic handwriting, the Vision fallback (MVP-145's own ticket), reprocessing documents left
PROCESSING by the old code (there is no production data yet).

**D-141 — Backups: encrypted dumps, off-provider copies and an automated restore test; provider settings left to the owner** · Accepted (MVP-113, 2026-10-25)
MVP-113 asks for PITR, snapshots, encrypted off-provider dumps, bucket versioning, a weekly restore test and a timed drill,
but no database, bucket or second provider is chosen yet (D-103, D-021) and choosing them commits spend. → As for staging
(D-103), the **repo side** ships now and is provider-agnostic; the provider settings are the owner's. **Tools:** one small image
(`infra/backup/Dockerfile`: `postgres:17.6-bookworm` — the client matches the server's major — plus `age` and `rclone`,
never pushed; `RCLONE_CONFIG=/dev/null`, remotes come from `RCLONE_CONFIG_<REMOTE>_*`) runs three bash scripts (`set -euo
pipefail`): `backup.sh` — `pg_dump -Fc --no-owner --no-privileges` piped through `age` (encrypted to every key in
`AGE_RECIPIENTS`) and streamed with `rclone rcat` to `weekly/nexlegtiq-<UTC stamp>.dump.age` in the backup bucket, also
copied to `monthly/` in the first week of a month; nothing unencrypted touches a disk or the bucket; a failed dump deletes
its partial object. `restore-check.sh` — the newest `weekly/` dump (refused when older than 8 days) is decrypted and restored
into an empty scratch database, then `verify.sql` asserts: every migration finished, the four extensions present,
`nlq_normalize_ar` works, no orphaned users, files or documents; it prints row counts and timings. `documents-copy.sh` —
`rclone copy --checksum` of the documents bucket to `documents/` in the backup bucket: **copy, never sync**, so a deletion or an
emptied bucket on the primary never propagates. **rclone** rather than the AWS CLI: two different providers in one command.
**Keys:** two age recipients — an **offline** key the owner keeps out of CI (the disaster key) and a **CI** key whose secret
(`BACKUP_AGE_IDENTITY`) only the restore test reads. **Workflow** `.github/workflows/backup.yml`: Sundays 02:00 UTC and on
demand, **off until the repository variable `BACKUP_ENABLED=true`**, GitHub Environment `backup` (secrets `BACKUP_ENV` — one
env file, as `STAGING_APP_ENV` in D-103 — `BACKUP_AGE_IDENTITY`, optional `SLACK_WEBHOOK_URL`); job 1 dumps and copies (the
env file written with umask 077 and removed afterwards); job 2 restores into a `pgvector/pgvector:pg17` service container
with the dev placeholder credentials (D-078, a throwaway database) and writes the report to the job summary — it receives
only the bucket settings, never the production database URL; job 3 posts failures to Slack when configured (GitHub emails
failed scheduled runs anyway). The dump runs as the **migrator** role (the read-only role cannot read token tables, D-079);
dumps carry no owners or grants, so a restore re-applies `db-roles.sql`. **Retention** is the bucket's lifecycle (weekly/ 90
days, monthly/ 365 days, documents noncurrent versions 90 days), not script deletes. **Honest RPO/RTO (amends
ops-security.md's "else 24 h"):** until provider PITR is enabled a database loss can lose up to **7 days** (the weekly dump),
and documents without bucket versioning up to 7 days; with PITR, ≤ 15 min. Restoring the data itself takes seconds at
today's size; the 4 h RTO is spent provisioning and switching. **Runbooks:** `docs/runbooks/backups.md` (what exists, first
setup, drills and their log), `restore-db.md`, `restore-documents.md`. **Drill:** `bash scripts/backup-drill.sh` runs the same
scripts against the dev stack (RustFS bucket, throwaway key); first run 2026-10-25: 206 KB dump, restore 1 s, checks 0 s, and a
wrong key is refused. **Owner's (posted on the ticket):** the backup provider and bucket, the two age keys, the GitHub
Environment and `BACKUP_ENABLED`, PITR (≥ 7 days) and daily snapshots on the managed Postgres, versioning on the documents
bucket, and the first production restore drill (logged in `backups.md`). Why: backups that are encrypted end to end, tested
every week and restorable by a runbook, the day the providers exist — without committing money or a region on the owner's
behalf.
Review additions (same PR): **the repository is public, so its Actions logs are:** the scripts print object names, sizes,
SHA-256 hashes and timings only — pg_dump/pg_restore/psql messages (which can quote table rows) and the row counts stay in
the container (`BACKUP_VERBOSE=1` shows them on an operator's machine, never in CI). **The dump runs as a new
`nexlegtiq_backup` role** (`db-roles.sql`: SELECT on every table and sequence, `default_transaction_read_only`, owns nothing;
Phase 3 RLS will need BYPASSRLS), not the migrator, so a leaked backup secret cannot change the schema. **TLS is enforced**:
`DATABASE_URL` must use `sslmode=verify-full|verify-ca` (with `sslrootcert=system`) and the bucket endpoint `https://`; only
the dev drill sets `BACKUP_ALLOW_INSECURE=1`. **Integrity:** each dump's SHA-256 goes into the run summary (a record apart
from the bucket) and `BACKUP_SHA256` makes a restore refuse any other file; only `nexlegtiq-<YYYYMMDDTHHMMSSZ>.dump.age`
names count, and a dump dated in the future is refused (a planted file would otherwise always sort newest). **Restores:**
`BACKUP_RESTORE_ROLE=nexlegtiq_migrator` (connected as the admin) makes the restored objects the migrator's, so `prisma
migrate deploy` and the SECURITY DEFINER purge (D-136) keep working; `--no-comments`; the offline key is mounted as a file
(`AGE_IDENTITY_FILE`), never passed on a command line; `BACKUP_NAME` picks a dump; the restored data needs the same
`ENCRYPTION_KEY` (D-108, D-135). **Documents (amends the above):** a **sync**, not a copy — documents purged on purpose (D-128
retention, erasure requests, the DPA) must also leave the backup — with `--backup-dir documents-deleted/<run>/` (kept 90 days
by lifecycle, so a mistaken deletion or a ransomware overwrite on the primary is recoverable) and `--max-delete 500` (an
emptied or wrong source bucket stops the run). **Bucket hardening (owner):** versioning and Object Lock where supported, a key
without delete-version rights, provider-side encryption, a region fitting D-021 and the provider on the sub-processor list.
**Workflow:** the restore job receives only `BACKUP_BUCKET_ENV` (bucket settings), every env value is masked, the `backup`
environment is limited to `main`, the monthly copy happens only on scheduled runs, and the summary is written even when the
restore fails. `verify.sql` now also checks the purge function (SECURITY DEFINER) and the `document_texts` search trigger.
**Not done:** images pinned by digest (the repo pins tags, D-078), a pre-migration snapshot in the deploy script (a provider
snapshot by hand until the release pipeline story).

**D-144 — AI quota month, successful operations, the usage endpoint and the daily cost alert** · Accepted (MVP-85, 2026-10-26) · Amends D-130, D-122, D-125
D-130 already records every AI answer (`AiUsage`, cost per call from `AI_MODEL_PRICES`, redaction counts, D-131) and checks
the quota before a job is queued and before every provider call; MVP-85 asked for "successful" operations, the month in the
**office's time zone**, `remaining=0` on refusal, a usage endpoint and the daily platform cost alert. → **What counts:**
new column `AiUsage.succeeded` (default true; migration `ai_usage_succeeded`): the executor records every paid answer as
before and marks whether it passed validation — an answer still invalid after its repair (AI-004) is recorded, priced and
**not counted**; cache hits stay free (amends D-130's "one usage row of a provider answer"). **The month** is the office's
calendar month in its time zone (`Office.timezone`, D-125; Asia/Hebron by default): `EntitlementsService.aiMonth()` finds
its first instant with shared-utils' `wallClock`/`zonedDateTime` (DST-safe, D-127); 23:30 UTC on 30 November is already
December in Hebron. **Refusal:** AUTH-103 carries one detail `{field: 'aiQuota', message: 'validation.aiQuotaReached', params:
{remaining: '0', quota, resetsAt}}` (new AR/EN key), so the app can say when the count restarts. **`GET /ai/usage`**
(`use:ai`: OM, SL, L, P, T) → `{used, quota, remaining, resetsAt}` (`quota`/`remaining` null for an unlimited plan) for the
AI tab (its UI story shows it); `GET /offices/me/subscription`'s usage gains `aiResetsAt`, shown in Settings → Subscription
("the AI count starts again on …"). **Cost alert:** `AI_COST_ALERT_THRESHOLD_USD` + `AI_COST_ALERT_EMAIL` (both or neither;
off when unset — the ticket's "default 20" is not applied, an alert needs a recipient): the `ai` queue's consumer gets a
platform job `ai-cost-alert`, scheduled daily at 06:00 UTC only when configured (removed otherwise), which sums the previous
UTC day's cost of every office (`unscoped`, only the sum leaves the query) and, above the threshold, logs an error and emails
the founder in plain English through the mail transport directly (it belongs to no office, so not through the tenant email
queue; founder-facing, so not translated). **Sentry event: deviation** — no error tracker exists yet (monitoring story,
waiting for the owner's vendor choice); the error log line is what it will pick up. **Not done:** a per-office cost report
(admin panel), alerting more than once a day, reserving quota for concurrent jobs (D-130's known limit stands).
Review additions (same PR): **AI use is visible to AI users (amends D-122's visibility rule):** `GET /ai/usage` shows used,
quota and remaining to every `use:ai` holder (OM, SL, L, P, T) — the AI tab tells its users what is left — while the
subscription view keeps head count, storage and the other limits for `manage:subscription` holders; AI counts reveal
nothing about the office's size. **The cost check cannot be impersonated:** its name is reserved in the job registry, and
the processor runs it only for a job without an office in its data (what the scheduler queues), within 60 s; it is
scheduled with **one attempt** (a send that failed after delivery never emails twice) by workers that have the setting, and
never removed at boot (a worker without it would undo the others' schedule; a run without the setting does nothing — to stop
it for good, remove the scheduler by hand). The office's time zone is **cached like the entitlements** (30 s), so a quota
check costs no extra query; unlimited plans skip the count. The daily sum scans `ai_usages` by `created_at` without an index
of its own — accepted at today's volume (one query a day). Integration test: rows at 21:59 and 22:01 UTC on 31 January fall in
January and February of Hebron respectively, and the refusal carries `remaining: '0'`.
**D-145 — Platform admin realm: TOTP sign-in, enrolment, sessions, IP allow-list and the platform audit log** · Accepted (MVP-101, 2026-10-26) · Amends D-079, D-080
MVP-101 fixed the model (mandatory TOTP, separate secret and audience, 8 h / 30 min sessions, optional IP allow-list,
audited admin actions) and left the flow, storage and first-admin path open; D-079 left platform-level audit "to the admin
panel". → **Module** `src/modules/platform-auth` (platform code: every query on the raw client with a reason, D-080).
**Sign-in** is one request: `POST /admin/auth/login {email, password, code? | recoveryCode?}` — D-053 lockout per email + IP
(the global `LoginAttempt` table, shared with office sign-in), Argon2id with the dummy-hash rule (D-082) → 401 AUTH-001;
inactive → 403 AUTH-006; no code → **401 AUTH-008** (with the detail `validation.mfaEnrollment` when the authenticator is not
set up yet, so the app goes to enrolment); wrong code → **401 AUTH-009** (counted as a failure). **TOTP** is RFC 6238
(HMAC-SHA1, 6 digits, 30 s, ±1 step) on Node's crypto — no library (`totp.ts`, tested on the RFC vectors); the last accepted
step is stored (`mfaLastStep`, claimed conditionally) so **a code is never accepted twice**. **Enrolment** proves the
password each time (no extra token): `POST /admin/auth/enroll` → `{otpauthUri, secret}` (a new secret, **encrypted at rest**
with the field cipher, D-056; asking again replaces an unconfirmed one) and `POST /admin/auth/enroll/confirm {…, code}` → 201
session plus **ten recovery codes** shown once (`XXXXX-XXXXX`, base32, SHA-256 at rest — high-entropy, so no slow hash;
case and dash ignored; each works once); re-enrolling an enrolled admin is 409 RES-003 (resetting an authenticator is a later
admin-panel action). **Tokens:** access JWT HS256, `aud=admin`, `iss=nexlegtiq`, 15 min, claims `{sub, sid}`, signed with the
new **`ADMIN_JWT_SECRET`** (≥ 32, must differ from `JWT_SECRET`, placeholder refused in production) — the office guard
(`aud=office`, other secret) never accepts it, nor the admin guard an office token. Without `ADMIN_JWT_SECRET` the realm is
off: its routes answer **404**. **Sessions** (`platform_sessions`): opaque refresh token (SHA-256), cookie **`nlq_admin_rt`**
(httpOnly, Secure, **SameSite=Strict**, path `/api/v1/admin/auth`, the D-089 realm path), **8 h from sign-in at most and 30 min
after the last refresh**; rotation claims the old token conditionally; a reused or raced token ends its whole family (written
outside the refused transaction, so it sticks); refresh and logout need the D-055 Origin + X-Requested-With check; logout is
idempotent. `AdminAuthGuard` also checks that the token's session is still live, so **signing out stops the access token at
once** (unlike the office realm's 15 min). **IP allow-list:** optional `ADMIN_IP_ALLOWLIST` (IPs and CIDRs, IPv4/IPv6, checked
at boot) on **every** admin route, sign-in included, via Node's `BlockList` on the client address after `TRUST_PROXY_HOPS`
→ 403 AUTH-100 otherwise. **Platform audit log (amends D-079):** a table of its own, `platform_audit_logs` (admin, action,
target office, entity, old/new values, IP, user agent, request id), **append-only** (UPDATE/DELETE revoked from the app role
in the migration and `db-roles.sql`) — the office `audit_logs` keeps its required `officeId`. Today it records `LOGIN`,
`LOGIN_RECOVERY_CODE`, `MFA_ENROLLED` and `LOGOUT`; admin features write their actions through `PlatformAuditService`. The
read-only role never reads sessions or recovery codes. **First admin:** no signup — `ADMIN_EMAIL=… ADMIN_NAME=… pnpm nx run
backend-api:create-admin` (refuses an existing email, prints a random first password once; deploy runbook step 7).
**Split:** the admin panel's sign-in, QR enrolment and recovery-code screens are their own story (created, blocked by this
one), since the backend realm alone is a full story. **Not done:** changing an admin's password or resetting their
authenticator (admin-panel stories), notifying on new sign-ins, WebAuthn.
Review additions (same PR): **only the admin panel may use the admin cookie** — refresh and logout accept the Origin
check against a new **`ADMIN_ORIGINS`** list (default `http://localhost:4201`, https in production), not the shared
`CORS_ORIGINS`: an XSS on the office app or the portal (allowed CORS origins on the same site, D-089) could otherwise refresh an
admin's session and read the token. **Account-wide lock:** besides the per-address D-053 lock, **10 failures for one admin
from any address within 15 minutes** (wrong passwords and wrong codes alike) lock the account (AUTH-007) — a botnet cannot
spread guesses of the 6-digit code (`LoginAttemptRepository.accountFailures`). **Enrolment within a day:** `enroll` and
`confirm` are refused with 410 RES-004 more than 24 h after `create-admin` — a leaked first password cannot be used to
take the account later (re-create the admin instead); within the day, whoever confirms first owns it (the operator enrols
right away). **Atomic enrolment:** confirming, the recovery codes, the audit row and the first session commit in one
transaction (the codes are never stored without being shown); `enroll` refuses (409) when the authenticator was confirmed
meanwhile instead of showing a secret that was never stored; recording a successful attempt after the commit is best
effort (logged). **A reused or raced refresh token** also writes a `SECURITY` row (`REFRESH_TOKEN_REUSED`). The realm uses
the office realm's `PasswordHasher` and `LoginAttemptRepository` (exported by `AuthModule`) and a `JwtService` of its own
token (`ADMIN_JWT`), so the office realm's `JwtService` stays the only unnamed one. **Confirms D-089:** the admin refresh path
`admin/auth/refresh` (cookie `nlq_admin_rt`, SameSite=Strict); the admin panel must serialise refreshes across tabs (a
concurrent reuse ends the session, tested). The access token lives 15 min but stops at once when its session ends; 8 h is a
hard cap whatever the refreshes. Integration tests: the office origin refused on refresh, two concurrent refreshes (at most
one wins, the family ends, a SECURITY row), two parallel confirmations (201 + 409, one set of codes), the enrolment window.
**D-143 — Document preview drawer: bytes fetched by the app, pdf.js, the text tab and versions** · Accepted (owner chose option A for both questions; MVP-146, 2026-10-26) · Amends D-133
D-085 serves every presigned link as an attachment, never inline, so the ticket's "inline via the presigned URL" could not
work as written, and D-128 lets only the current version be downloaded. → **Bytes:** the drawer asks `GET
/documents/:id/download` (the audited link, D-128) and **fetches the bytes itself** (`credentials: 'omit'`, no referrer) —
the storage domain never renders anything, nothing on the server changed. This needs a **bucket CORS rule** (`GET`/`HEAD`
from the office-app origins only): the dev stack's `s3-init` sets it on RustFS, the owner sets it on the production bucket
(`docs/runbooks/deploy.md`), and the SPA's CSP, once defined, must allow `img-src blob:`, `worker-src 'self'` and the bucket
in `connect-src`. **Drawer** (`features/cases/documents/preview`), opened from the document's name in the list (a button,
`documents.preview.open`): title with the status, **Download** (a fresh link, followed as the attachment), and tabs mounted
when first shown, so a preview, a text page or a link — each an audit row — is asked for only when looked at.
**Preview:** PDFs through **pdf.js 6.3** (`pdfjs-dist`, pinned, a root dependency; loaded on first use in its own chunk,
worker served from the app's assets, XFA off; pdf.js 6 has no `eval` font path, CVE-2024-4367), one page at a time on a
canvas at the drawer's width with a pager; PNG and JPEG through an object URL (revoked when closed); TIFF, Word, Excel, CSV
and legacy `.doc` get "cannot be previewed — read its text or download it" and no link is asked for. Bytes are kept only
while shown (`gcTime: 0`, up to 50 MB) and never retried by themselves (each try is an audited link). A document not yet
scanned clean shows the API's own reason (BIZ-015 / STO-004); a storage fetch that fails is **STO-002** ("the download
failed") with a retry. **Text:** the current version's text, 20,000 characters a page (D-128), with a search that marks
every case-insensitive match on the page and says how many (Arabic plural forms); the text block is `dir="auto"` with
`unicode-bidi: plaintext`, so every paragraph takes its own direction (Arabic right to left, English left to right) in either
interface language; "not ready yet" while OCR is PENDING, "no text" otherwise. **Versions:** every stored upload, newest
first (version, uploaded name, author, date, size, note); **only the current version has a download** (D-128) — older ones
show a disabled button explaining it; "upload a new version" (one file, the client checks of D-133, an optional note up to
500 characters, progress) for those who may upload and not on an archived file — the API decides who may replace a
colleague's document (D-126). Shared API client: `documentsApi.get|versions|downloadLink|text|uploadVersion`. **Amends
D-133:** the "download/preview and version history" it deferred are done. **Not done:** downloading older versions (needs a
per-version scan record, a backend story), search across pages of the text (global search), Arabic-normalised highlighting
(hamza/alef variants are not folded when marking), thumbnails, previews in the list, the Cypress journey (E2E story).
Review additions (same PR): **only the latest page draws** — a newer page or width cancels the running render and an
older request stops after loading its page (paging fast once broke the whole preview: two renders on one canvas); the
canvas is **capped at 16 MP** (pdf.js's own default — a hostile 1 × 14,400 pt page could otherwise take the tab down) and
follows the pane's width through a `ResizeObserver` (the drawer animates open and can be resized). **Fewer audit rows:**
text pages have their own query prefix like the bytes (`document-text`), fetched once per version — the realtime
`document.processed` refresh and other documents' writes no longer re-read the open page (each read is a `VIEW` row,
D-128); the drawer's text starts on page 1 for a new version. **Bytes wait for a clean scan:** a document that is not
openable (anything but READY, PROCESSING, or FAILED after the scan) shows why (BIZ-015 / STO-004) without asking for a
link, and its preview appears by itself once `document.processed` refreshes it. The download mutation keeps no link
(`gcTime: 0`). Text paragraphs align to their own start (`unicode-bidi: plaintext` + `text-align: start`, no page-level
`dir`); image `alt`, sizes and names are bidi-isolated; pagers are labelled `<nav>`s. **Worker CSP (deviation from the
ticket's wording):** pdf.js's worker is served as one of the app's own assets, so the SPA needs `worker-src 'self'`, not
`blob:` — narrower than the ticket asked; a CDN that serves assets from another origin must add that origin. The bucket may
answer with `Access-Control-Allow-Credentials: true`; harmless, the fetch sends no credentials.
**D-142 — Google Vision fallback for hard-to-read scans: opt-in, page budget, EU endpoint, cost per document** · Accepted (owner chose the recommended options; MVP-145, 2026-10-25) · Amends D-122, D-139
Vision receives unredacted document images (scans cannot be PII-redacted, D-057), so the owner chose (Jira comment on the
ticket): **office opt-in + plan flag, a monthly page budget, the EU endpoint and the owner's GCP project.** → **When:** after
Tesseract (D-139), a scan whose mean confidence is below `OCR_VISION_MIN_CONFIDENCE` (default 70), or where Tesseract read no
word on a scan that has pages, is re-read by Google Cloud Vision `DOCUMENT_TEXT_DETECTION` — only when **all** of: Vision is
configured (`GOOGLE_VISION_CREDENTIALS`), the plan's flag `googleVisionOcr` is on (D-122; still off by default on every plan),
the office's new setting **`enableVisionOcr`** is on (`office_settings.enable_vision_ocr`, default false, shown in Settings →
Practice defaults with what it means, audited like every setting, D-125), and the **page budget** has room for every page of
the scan: new plan column **`ocrPagesMonthly`** (default 0 = no Vision; the admin panel sets it per plan; `EntitlementsService
.visionPagesLeft()` = budget − pages Vision read this UTC month, counted from `document_texts` rows with engine
`google-vision`). Vision's result then **replaces** Tesseract's (engine `google-vision`, confidence and per-page confidence
from Vision's page confidences); a scan over the remaining budget keeps Tesseract's result. **How:** `extraction/vision.ts`
calls `POST {GOOGLE_VISION_ENDPOINT}/v1/images:annotate` (default `https://eu-vision.googleapis.com`, `https` required in
production) with the API key in the **`x-goog-api-key` header, never the URL** (as Gemini, D-130), one page per request, two at
a time, language hints `ar` and `en`, 30 s per request inside the attempt's abort signal. PDFs are rasterized for it by the
same sandboxed `pdftoppm` as Tesseract (D-139: minimal environment, crop box) at 200 dpi JPEG, 10 pages a batch; JPEG and PNG
are sent as they are up to 7 MB (larger ones, and TIFF, keep Tesseract's result). **Credentials:** `GOOGLE_VISION_CREDENTIALS`
is an API key restricted to the Vision API in the owner's GCP project (simpler than a service account for one API; rotate in
the console), redacted in logs, refused in production when it is a documented placeholder. **Errors:** a `VisionError` carries
only a code (`HTTP_<status>`, `VISION_<code>`, `NETWORK`, `EMPTY_RESPONSE`) — the provider's message (which can quote the
request) is never logged or stored; it fails the attempt, the queue retries (D-084), and the last attempt marks the document
FAILED with EXT-002 (retry endpoint, D-132). **Cost:** `GOOGLE_VISION_PRICE_PER_1000_PAGES` (default 1.5 USD) × pages, computed
with decimal.js (D-017) and stored per version in the new column `document_texts.ocr_cost_usd` (`Decimal(10,6)`, CHECK ≥ 0),
and logged with the document id and pages. **Owner, before switching it on:** create the GCP project and key (Vision API only),
put Google on the DPA sub-processor list (D-021), set `ocrPagesMonthly` and the `googleVisionOcr` flag on the plans that include
it. **Not done:** TIFF pages through Vision, showing the page budget in the subscription view, a per-office cost report.
Review additions (same PR): **a Vision failure never fails the document** — a provider error, a network failure or Vision's
own **90 s deadline** inside the attempt (the 300 s `ocr` timeout also holds Tesseract's run, D-139) keeps Tesseract's result
(logged by code only); only the job's own abort propagates. So a Vision outage cannot fail every weak scan, and the queue
never retries — and pays again for — a Vision read. **Vision's text is kept only when it reads better** (text, and a mean
confidence above Tesseract's); otherwise Tesseract's text stays, but the cost is stored all the same (the pages were paid):
**the budget counts every version with an `ocr_cost_usd`**, whichever text was kept (partial index `(office_id,
extracted_at) WHERE ocr_cost_usd IS NOT NULL`). **Never sent to Vision:** documents marked confidential (a cheap, safe default
— the owner can relax it), and scans of a read-only office (D-122). **Production endpoint** must be `https://*.googleapis.com`
(the key and unredacted scans go there). A failed response body is cancelled unread. **Amends D-057/D-131:** PII redaction
covers text sent to LLMs; Vision receives the scan image itself — the privacy policy and DPA must name Google Vision for
offices that opt in (ops-security.md). **Known limits:** the page budget is checked, not reserved — parallel OCR jobs of one
office (concurrency 2) can overshoot it by about one scan each (as the AI quota, D-130); pages read before Vision's deadline
or a failure are paid but not counted; nothing ships `ocrPagesMonthly` or the `googleVisionOcr` flag on a plan, so Vision is
off everywhere until the owner sets them.
