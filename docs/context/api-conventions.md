# API Conventions & Endpoint Map

> Source: "Complete API Documentation", Dev Guidelines, Flow Charts. Resolutions: D-013, D-014, D-019.

## Shape
- Base `/api/v1`; Swagger UI `/api/docs` (on by default outside production, off in production unless `SWAGGER_ENABLED=true`);
  OpenAPI JSON `/api/docs-json`.
- Resources plural kebab-case; tenant from token, never from path.
- JSON camelCase; dates ISO-8601 UTC (`timestamptz`); money as decimal strings + `currency`.
- Envelope (always):
```json
{ "success": true, "data": {}, "meta": { "timestamp": "…", "requestId": "…",
  "pagination": { "page": 1, "limit": 20, "total": 0, "totalPages": 0, "hasMore": false } } }
{ "success": false, "error": { "code": "VAL-001", "message": "…", "details": [{ "field": "title", "message": "…" }] },
  "meta": { "timestamp": "…", "requestId": "…" } }
```
- Pagination `?page=1&limit=20` (max 100); cursor (`?cursor=`) for timeline/audit/notifications.
  Sorting `?sort=createdAt:desc,priority:asc` (allow-listed fields). Filters as query params validated by `XQuerySchema`.
- Async work → `202 { jobId, status }`; poll `GET /jobs/:id` or listen to WS.
- `error.message` is an English developer message; the FE maps `code` → i18n key `errors.<CODE>`.
- Idempotency: `Idempotency-Key` header honored on POST create endpoints for uploads, invoices, sessions (Redis 24h).

## Error codes
AUTH-001 invalid credentials · 002 token expired · 003 token invalid · 004 refresh expired · 005 refresh invalid ·
006 user inactive · 007 locked · 008 MFA required · 009 MFA invalid · 010 email not verified
AUTH-100 permission denied · 101 insufficient role · 102 plan feature not available · 103 quota exceeded
VAL-001 invalid input · 002 email · 003 phone · 004 date · 005 file type · 006 file too large · 007 required
RES-001 not found (incl. cross-tenant) · 002 already exists · 003 conflict/version · 004 deleted
BIZ-001 last office manager · 002 case already closed · 003 open tasks block close · 004 session conflict ·
005 retainer insufficient · 006 invoice immutable · 007 file archived · 008 user limit reached · 009 party conflict of interest · 010 client has open files
AI-001 provider unavailable · 002 rate limited · 003 input too large · 004 output invalid · 005 AI disabled for office
STO-001 upload failed · 002 download failed · 003 delete failed · 004 malware detected
EXT-001 email provider · 002 OCR provider
RATE-001 rate limit · SYS-001 internal · SYS-002 service unavailable (readiness check failed, 503) · DB-001 database
Canonical list in code: `packages/shared-types/src/api/error-codes.ts`; HTTP status per code: `apps/backend-api/src/common/errors/error-catalog.ts`.
Prisma mapping: P2002 → 409 RES-002, P2025 → 404 RES-001, P2034 → 409 RES-003, else 500 DB-001.
HTTP status per code and framework-error mapping: D-075. A `ZodError` thrown by server code (not the request pipe) is 500 SYS-001.
Request ids: D-076.

## Rate limits (Redis, per ip+user)
default 100/min · `/auth/login|register|forgot-password|reset-password` and `users/me/password` 5/min · `/auth/verify-email` 10/min · `/auth/resend-verification` 3/min · `/auth/refresh` 30/min ·
uploads 20/min ·
`/ai/*` 20/min (plus plan quota) · search 60/min. Headers `X-RateLimit-Limit|Remaining|Reset`, `Retry-After`.

## Endpoint map (MVP)
**auth**: POST `auth/register` (office signup, 201 + session like login) · POST `auth/login` · POST `auth/refresh` · POST `auth/logout` ·
POST `auth/forgot-password` (always 200) · POST `auth/reset-password` (204; 410 RES-004 for an invalid/used/expired link, D-086) · POST `auth/verify-email` (204; 410 RES-004 for an invalid/used/expired link) · POST `auth/resend-verification` (always 202, D-085) · POST `auth/accept-invite` ·
GET `auth/invites/:token` (preview)
**users**: GET/PATCH `users/me` · POST `users/me/password` (204; wrong current password → 400 VAL-001, D-086) · GET `users` (office team) · POST `users/invite` ·
GET `users/invitations` · DELETE `users/invitations/:id` · PATCH `users/:id/role` · POST `users/:id/deactivate` (with reassignment) ·
POST `users/:id/reactivate`
**offices**: GET `offices/me` · PATCH `offices/me` · GET/PATCH `offices/me/settings` · GET `offices/me/subscription` ·
GET `offices/me/statistics` · POST `offices/me/export` (202)
**clients**: CRUD `clients` (+ `?search, clientType, sort`) · `clients/:id/contacts` CRUD · GET `clients/:id/files` ·
GET `clients/:id/invoices` · `clients/:id/notes` · portal access: POST `clients/:id/portal-invitations`, GET/DELETE `clients/:id/portal-users`
**cases** (legal files): POST/GET `cases` (`?status, fileType, priority, scope=mine|all, search, clientId, sort`) · GET/PATCH/DELETE `cases/:id` ·
POST `cases/:id/close` · POST `cases/:id/reopen` · POST `cases/:id/archive` · POST `cases/:id/reassign` ·
`cases/:id/clients` · `cases/:id/team` · `cases/:id/parties` (POST returns conflicts) · `cases/:id/witnesses` (+statements) ·
GET `cases/:id/timeline` · `cases/:id/notes` · GET `cases/:id/audit` · GET `conflicts` · PATCH `conflicts/:id/resolve` ·
GET `parties?search=` (reuse) · CRUD `task-templates`
**courts**: GET `courts?jurisdiction&search` (global+office) · POST/PATCH `courts` (office-owned) · `courts/:id/judges` · `prosecutors`
**sessions**: POST `sessions` (409 BIZ-004 unless `acknowledgeConflict`) · GET `sessions?from&to&lawyerId&fileId` (calendar) ·
GET/PATCH `sessions/:id` · POST `sessions/:id/cancel` · POST `sessions/:id/outcome` (outcome+minutes → optional AI) ·
POST `sessions/reminders/:id/ack`
**documents**: POST `documents` (multipart: file, fileId, documentType, folderId?, sessionId?) → 202 ·
GET `cases/:id/documents?folderId&type&search` · GET/PATCH/DELETE `documents/:id` · GET `documents/:id/download` →
`{downloadUrl, expiresIn: 300}` · POST `documents/:id/versions` · GET `documents/:id/versions` · GET `documents/:id/text` ·
POST `documents/:id/share` / `unshare` · POST `documents/:id/ocr/retry` · CRUD `cases/:id/folders`
**tasks**: CRUD `tasks` (`?fileId, assignee=me|<userId>, status, priority, dueBefore, overdue`, page/limit) · PATCH `tasks/:id/status` · PATCH `tasks/reorder` (204) · POST `tasks/bulk-assign` (200 `{updated}`) — D-098
**billing**: CRUD `time-entries` · POST `time-entries/timer/start|stop` · POST `invoices` (from time entries, `fileId?` null=consolidated) ·
GET `invoices` · GET/PATCH `invoices/:id` · POST `invoices/:id/send` · POST `invoices/:id/mark-paid` · POST `invoices/:id/void` · GET `invoices/:id/pdf`
**search**: GET `search?q&type=all|cases|clients|documents|parties|tasks&limit` (grouped)
**ai**: POST `ai/summaries` `{sourceType, sourceId, language}` → 202 · GET `ai/summaries?sourceType&sourceId` · GET `jobs/:id` · GET `ai/usage` (quota)
**notifications**: GET `notifications` · POST `notifications/:id/read` · POST `notifications/read-all` · GET/PATCH `notifications/preferences`
**dashboard**: GET `dashboard` (role-aware KPIs + upcoming + activity)
**audit**: GET `audit?entityType&entityId&userId&from&to` · GET `audit/export`
**portal** (`/api/v1/portal`, portal realm): POST `auth/login|refresh|logout|accept-invite|forgot-password|reset-password` ·
GET `me` · GET `files` · GET `files/:id` (status, next hearing, public timeline) · GET `files/:id/documents` · GET `documents/:id/download` ·
POST `files/:id/uploads` (quarantined into CLIENT_UPLOADS) · GET `invoices` · GET `invoices/:id/pdf`
**admin** (`/api/v1/admin`, platform realm + MFA): offices list/detail/suspend · plans CRUD · subscriptions assign/extend/record-payment ·
usage (AI, storage) · platform audit
**health** (not under the `/api/v1` prefix): GET `/health` (liveness) · GET `/health/ready` (checks registered in
`ReadinessRegistry` by the db/redis/storage modules; 503 SYS-002 naming failed checks) · GET `/metrics` on its own internal
port `METRICS_PORT` (never published)

## WebSocket
socket.io `/ws`, `auth: { token }`; server joins `office:{officeId}` + `user:{userId}` (portal: `client:{clientUserId}`).
Payload: `{ type, occurredAt, data }`. Never broadcast tenant data to a room other than its office.
