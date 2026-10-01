import { createHash, randomBytes } from 'node:crypto';

import { SetMetadata } from '@nestjs/common';
import type { CookieOptions } from 'express';

/** auth-rbac.md, Tokens / Flows; D-050, D-053. */
export const ACCESS_TOKEN_TTL_SECONDS = 900;
export const REFRESH_TTL_DAYS = 7;
export const REFRESH_TTL_REMEMBER_DAYS = 30;
export const JWT_ISSUER = 'nexlegtiq';
export const JWT_AUDIENCE = 'office';

export const REFRESH_COOKIE = 'nlq_rt';
const REFRESH_COOKIE_PATH = '/api/v1/auth';

export const LOCKOUT_MAX_FAILURES = 5;
export const LOCKOUT_WINDOW_MS = 15 * 60_000;

const DAY_MS = 86_400_000;

/** Opens a route to unauthenticated callers (JwtAuthGuard is global and deny-by-default). */
export const IS_PUBLIC_KEY = 'nexlegtiq:public';
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);

/** Access JWT claims. No permissions or role trust: the guard reloads the user on every request (D-081). */
export interface AccessTokenClaims {
  readonly sub: string;
  readonly officeId: string;
  readonly role: string;
  /** Refresh-token family (session id). */
  readonly sid: string;
}

/** 32 random bytes, base64url: the opaque refresh token sent only in the cookie. */
export function newRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Refresh tokens are stored as SHA-256 only (auth-rbac.md); a database leak yields no usable token. */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function refreshExpiry(now: Date, rememberMe: boolean): Date {
  return new Date(now.getTime() + (rememberMe ? REFRESH_TTL_REMEMBER_DAYS : REFRESH_TTL_DAYS) * DAY_MS);
}

/** httpOnly Secure SameSite=Lax, scoped to the auth endpoints only (D-050). */
export function refreshCookieOptions(expiresAt?: Date): CookieOptions {
  return {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: REFRESH_COOKIE_PATH,
    ...(expiresAt ? { expires: expiresAt } : {}),
  };
}
