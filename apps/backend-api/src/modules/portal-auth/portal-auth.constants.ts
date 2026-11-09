import type { CookieOptions } from 'express';

/** The client-portal realm (D-158): its own token audience, secret, cookie and session limits. */
export const PORTAL_AUDIENCE = 'portal';
/** The realm's own JwtService (no default secret): an office or admin token never verifies with it. */
export const PORTAL_JWT = Symbol('PORTAL_JWT');
export const PORTAL_ACCESS_TTL_SECONDS = 900;
const DAY_MS = 86_400_000;
/** A refresh token lasts 7 days; no session outlives 30 days from its sign-in, however often it rotates. */
export const PORTAL_REFRESH_TTL_MS = 7 * DAY_MS;
export const PORTAL_SESSION_MAX_MS = 30 * DAY_MS;
export const PORTAL_INVITATION_DAYS = 7;
export const PORTAL_RESET_LINK_MINUTES = 60;
/** Lockout (D-053) is keyed on `portal:<email>` so portal failures never lock the same address out of the office app. */
export const portalAttemptKey = (email: string): string => `portal:${email}`;

export const SEND_CLIENT_INVITATION_JOB = 'send-client-invitation';
export const SEND_CLIENT_PASSWORD_RESET_JOB = 'send-client-password-reset';

export const PORTAL_REFRESH_COOKIE = 'nlq_prt';
const PORTAL_REFRESH_COOKIE_PATH = '/api/v1/portal/auth';

/** httpOnly Secure SameSite=Lax, path /api/v1/portal/auth (D-050, D-158). */
export function portalCookieOptions(expiresAt?: Date): CookieOptions {
  return {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: PORTAL_REFRESH_COOKIE_PATH,
    ...(expiresAt ? { expires: expiresAt } : {}),
  };
}

/** Access JWT claims of a portal account: `sid` is the session family. */
export interface PortalAccessClaims {
  readonly sub: string;
  readonly sid: string;
}
