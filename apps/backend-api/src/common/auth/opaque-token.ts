import { createHash, randomBytes } from 'node:crypto';

/** 32 random bytes, base64url: refresh tokens, email-verification links (D-082, D-083). */
export function newOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Opaque tokens are stored as SHA-256 only: a database leak yields no usable token. */
export function hashOpaqueToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
