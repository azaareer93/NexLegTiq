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

**D-083 — Office signup and email verification** · Accepted (owner chose schema, plan mapping and the email split; MVP-39, 2026-10-01)
→ `POST /auth/register` (5/min per IP) creates, in **one transaction on the raw client** (the office does not exist yet,
D-080): Office (`accountType` SOLO|FIRM|CORPORATE, new column), OfficeSettings (schema defaults: reminders 7/3/1, file
number `{YEAR}-{TYPE}-{SEQ:5}`), the OFFICE_MANAGER user (Argon2id, `uiLanguage` EN only for an English office, else AR),
a `TRIALING` subscription, ToS + Privacy `LegalAcceptance` rows, the verification link and a `CREATE Office` audit row.
**Plan:** jurisdiction PALESTINE → `PS_FREE` (180 days); elsewhere a 30-day trial sized by account type: SOLO →
`GLOBAL_SOLO`, FIRM → `GLOBAL_SMALL_FIRM`, CORPORATE → `GLOBAL_PROFESSIONAL`; `trialEndsAt = currentPeriodEnd = now +
plan.trialDays`. **Legal versions** are server constants (`LEGAL_VERSIONS`, bumped when a text changes); the client only
sends `acceptTerms: true` and `acceptPrivacy: true`. Then the manager is logged in like `/auth/login` (201 + session +
cookie) in a second, scoped transaction — a failure there leaves a complete office the user can log in to. An existing
email → 409 RES-002 (D-032; a racing duplicate loses on the unique index). **Password policy** follows auth-rbac.md (≥10,
upper + lower + digit, not a well-known password, not the email), not the Notion onboarding page's 8+; the common list is
short (a breached-password check can replace it). **Email verification:** `User.emailVerifiedAt` + `EmailVerificationToken`
(32 random bytes, SHA-256 at rest, 7 days, single use, tenant table hidden from the read-only role). `POST /auth/verify-email`
→ 204; an unknown, used or expired link → **410 RES-004** (not 401, so the SPA's refresh-on-401 never fires on a public
link). Login and refresh responses carry `emailVerified` and `verifyBy` for the banner. Once 7 days pass unverified, login,
refresh and every Bearer request get **403 AUTH-010** (refresh also revokes the session). Accounts that existed before the
migration (seeds, invitations) are backfilled as verified. **Sending** the AR/EN email, and a resend endpoint, belong to the
email adapter story: until then `VerificationMailer` logs that delivery was skipped (never the token). Why: one-step
freemium signup now, without building email delivery twice.
