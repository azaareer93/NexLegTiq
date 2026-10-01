/** auth-rbac.md (Tokens, Flows); D-050, D-053, D-082. */
export const ACCESS_TOKEN_TTL_SECONDS = 900;
export const JWT_ISSUER = 'nexlegtiq';
export const JWT_AUDIENCE = 'office';

export const LOCKOUT_MAX_FAILURES = 5;
export const LOCKOUT_DURATION_MS = 15 * 60_000;

/**
 * Access JWT claims. `role` is informational only: the guard reloads the user on every request (D-081). `sid` is the
 * refresh-token family (session) id, reserved for revoking access tokens before they expire.
 */
export interface AccessTokenClaims {
  readonly sub: string;
  readonly officeId: string;
  readonly role: string;
  readonly sid: string;
}
