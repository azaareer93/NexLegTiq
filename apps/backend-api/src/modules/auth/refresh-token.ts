import type { CookieOptions } from 'express';

/** The opaque refresh token travels only in this httpOnly cookie, scoped to the auth endpoints (D-050). */
export const REFRESH_COOKIE = 'nlq_rt';
const REFRESH_COOKIE_PATH = '/api/v1/auth';

const DAY_MS = 86_400_000;
export const REFRESH_TTL_DAYS = 7;
export const REFRESH_TTL_REMEMBER_DAYS = 30;
/** No session outlives this, however often it rotates (D-082). */
export const SESSION_MAX_AGE_DAYS = 90;

export function refreshExpiry(now: Date, rememberMe: boolean): Date {
  return new Date(
    now.getTime() + (rememberMe ? REFRESH_TTL_REMEMBER_DAYS : REFRESH_TTL_DAYS) * DAY_MS,
  );
}

/**
 * Expiry of a rotated token: the same lifetime as the one it replaces, but never past the session's absolute cap
 * (counted from the family's first token), so a session that keeps refreshing still ends.
 */
export function rotatedExpiry(
  now: Date,
  previous: { createdAt: Date; expiresAt: Date },
  familyStartedAt: Date,
): Date {
  const lifetime = previous.expiresAt.getTime() - previous.createdAt.getTime();
  const cap = familyStartedAt.getTime() + SESSION_MAX_AGE_DAYS * DAY_MS;
  return new Date(Math.min(now.getTime() + lifetime, cap));
}

/** httpOnly Secure SameSite=Lax, path /api/v1/auth (D-050). */
export function refreshCookieOptions(expiresAt?: Date): CookieOptions {
  return {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: REFRESH_COOKIE_PATH,
    ...(expiresAt ? { expires: expiresAt } : {}),
  };
}
