# Auth, RBAC & Tenant Isolation

> Source: "Complete Authentication & Authorization Documentation", Security doc, Workflows W1/W2/W5/W7/W8.
> Resolutions: D-018, D-019, D-032, D-050…D-055.

## Tokens
| Token | Lifetime | Where | Payload |
|---|---|---|---|
| Access JWT (HS256, `JWT_SECRET`) | 15 min | FE memory (Zustand, not persisted) | `{sub, officeId, role, sid}` — `role` informational (reloaded per request), `sid` = refresh family, reserved |
| Refresh (opaque random 32B, stored SHA-256 in `refresh_token`) | 7 days (30 with "remember me") | httpOnly Secure SameSite=Lax cookie `nlq_rt`, path `/api/v1/auth` | – |
Rotation on every refresh; reuse of a revoked token ⇒ revoke the whole family (`sid`) + audit `SECURITY` event.
Permissions are **not** in the JWT; resolved server-side from role (cached) so role changes apply within one request.
Client portal uses a separate realm: audience `portal`, secret `JWT_PORTAL_SECRET`, cookie `nlq_prt`.

## Flows
- **Signup** (W1 + onboarding): office + OFFICE_MANAGER user + Free/Trial subscription + default settings +
  ToS acceptance, in one transaction; email verification link (must verify within 7 days to keep access). Plan, legal
  versions, auto-login, 410 for bad links and AUTH-010: D-083. The link is created and emailed by the worker; resend via
  `POST /auth/resend-verification` (always 202): D-085.
- **Login**: rate-limited per IP (login 5/min, refresh/logout 30/min) + lockout (D-053, details D-082). Inactive user → 403 `AUTH-006`.
  Response: `{accessToken, expiresIn: 900, user{id, fullName, email, role, officeId, officeName, uiLanguage, permissions[],
  emailVerified, verifyBy}}` (D-083).
- **Refresh**: `POST /auth/refresh` (cookie) → new pair. FE: single-flight refresh on 401, queue concurrent requests, retry once.
- **Logout**: revoke current family, clear cookie, FE clears stores + `queryClient.clear()`.
- **Password reset**: `forgot-password` always 200 (anti-enumeration); token 1h, single use; success revokes all sessions.
  Change password (`users/me/password`) ends every other session. Details: D-086.
- **Password policy**: ≥ 10 chars, upper+lower+digit (special optional), not in breached/common list, not equal to email.
  Argon2id (m=19 MiB, t=2, p=1), D-082.
- **Invite** (W2): OM invites → email with link (token 7 days) → accept: set name/password/phone → user created with role.
  Existing email anywhere → 409 (D-032).
- **Deactivate** (W5): must reassign open files (responsible lawyer) in same request; last OFFICE_MANAGER can't be
  deactivated (`BIZ-001`); revokes sessions.
- **MFA (TOTP)**: required for PlatformAdmin in MVP; optional for office users (Phase 5 enforcement).

## Roles
OFFICE_MANAGER (OM), SENIOR_LAWYER (SL), LAWYER (L), PARALEGAL (P), ADMIN (A — office admin/finance, read-only on
cases), TRAINEE (T), EXTERNAL_COLLABORATOR (X — assigned files only, minimal).

"Assigned" = user is responsibleLawyer, responsibleParalegal, or a FileTeamMember of the file.

## Permission matrix (single source of truth → `packages/shared-types/src/permissions.ts`)
| Permission | OM | SL | L | P | A | T | X |
|---|---|---|---|---|---|---|---|
| `view:all:cases` | ✓ | ✓ |  |  | ✓ |  |  |
| `view:assigned:cases` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `create:case` | ✓ | ✓ | ✓ | ✓ |  |  |  |
| `edit:assigned:case` | ✓ | ✓ | ✓ | ✓ |  |  |  |
| `edit:any:case` | ✓ | ✓ |  |  |  |  |  |
| `close:case` / `reopen:case` | ✓ | ✓ | resp. lawyer |  |  |  |  |
| `delete:case` (soft) | ✓ | ✓ |  |  |  |  |  |
| `manage:clients` | ✓ | ✓ | ✓ | ✓ | ✓ |  |  |
| `upload:document` | ✓ | ✓ | ✓ | ✓ |  | ✓ | ✓ |
| `delete:document` | ✓ | ✓ | ✓ |  |  |  |  |
| `share:document` (to client portal) | ✓ | ✓ | ✓ |  |  |  |  |
| `create:session` / `edit:session` | ✓ | ✓ | ✓ |  |  |  |  |
| `create:task` / `assign:task` | ✓ | ✓ | ✓ | ✓ |  |  |  |
| `complete:task` | ✓ | ✓ | ✓ | ✓ |  | ✓ | ✓ (own) |
| `log:time` | ✓ | ✓ | ✓ | ✓ |  | ✓ |  |
| `view:all:invoices` | ✓ |  |  |  | ✓ |  |  |
| `view:assigned:invoices` | ✓ | ✓ | ✓ | ✓ | ✓ |  |  |
| `generate:invoice` / `mark:invoice:paid` | ✓ | ✓ | ✓ |  | ✓ |  |  |
| `use:ai` | ✓ | ✓ | ✓ | ✓ |  | ✓ |  |
| `view:audit` | ✓ |  |  |  | ✓ |  |  |
| `view:reports` | ✓ | ✓ |  |  | ✓ |  |  |
| `manage:users` / `manage:office` / `manage:subscription` / `export:office` | ✓ |  |  |  |  |  |  |
| `manage:portal-access` (invite client users) | ✓ | ✓ | ✓ |  |  |  |  |
Guards: `JwtAuthGuard` (global, `@Public()` opt-out) → `PermissionsGuard` (`@RequirePermissions` = ALL,
`@RequireAnyPermission` = ANY) → service-level scope (`assigned` filter) → tenant extension. A file-level check
helper `assertFileAccess(fileId, mode)` is the only way services load a file for mutation.

## Tenant isolation (D-018)
1. `ClsModule` stores `{requestId, userId, officeId, role, permissions, realm}` per request/job.
2. `PrismaService` is extended with a query extension: for 🔒 models, `find*/count/aggregate/update*/delete*`
   get `where.officeId = cls.officeId`; `create*` gets `data.officeId`; missing context ⇒ throw
   `TenantContextMissingError` (workers must call `runInTenant(officeId, fn)`).
3. Cross-tenant ⇒ 404 (D-019). 4. Every cache key prefixed `o:{officeId}` (D-058). 5. Storage keys prefixed
`{officeId}/`. 6. WebSocket rooms per office/user. 7. Integration suite `tenant-isolation.int.spec.ts` + `tenant-isolation.matrix.ts` (D-080) iterates
all resource endpoints with a second office's token.

## Hardening checklist
helmet (HSTS 1y, CSP, frame-ancestors none, nosniff, referrer strict-origin), CORS allow-list per app, throttler
(Redis) with limits in `api-conventions.md`, request body limit 1 MB (uploads separate, 50 MB streamed),
Pino redaction (`authorization`, `cookie`, `password`, `token`, `*.nationalId`), secrets validated at boot,
audit on LOGIN/LOGOUT/PERMISSION_DENIED/EXPORT/DOWNLOAD/SHARE.
