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
