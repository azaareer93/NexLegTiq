import type { CookieOptions } from 'express';

/** The platform admin realm (D-145): its own token audience, cookie and session limits. */
export const ADMIN_AUDIENCE = 'admin';
/** The realm's own JwtService (no default secret): a token for the office realm's JwtService never resolves to it. */
export const ADMIN_JWT = Symbol('ADMIN_JWT');
export const ADMIN_ACCESS_TTL_SECONDS = 900;
/** A session ends 8 h after sign-in whatever happens, and after 30 min without a refresh. */
export const ADMIN_SESSION_MAX_MS = 8 * 3_600_000;
export const ADMIN_SESSION_IDLE_MS = 30 * 60_000;
export const RECOVERY_CODE_COUNT = 10;

export const ADMIN_REFRESH_COOKIE = 'nlq_admin_rt';
const ADMIN_REFRESH_COOKIE_PATH = '/api/v1/admin/auth';

export function adminCookieOptions(expiresAt?: Date): CookieOptions {
  return {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: ADMIN_REFRESH_COOKIE_PATH,
    ...(expiresAt ? { expires: expiresAt } : {}),
  };
}

/** Access JWT claims of an admin: `sid` is the session family. */
export interface AdminAccessClaims {
  readonly sub: string;
  readonly sid: string;
}
