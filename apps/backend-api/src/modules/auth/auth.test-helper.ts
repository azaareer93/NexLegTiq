import type { JwtService } from '@nestjs/jwt';

import { ACCESS_TOKEN_TTL_SECONDS, JWT_AUDIENCE, JWT_ISSUER } from './auth.constants';
import type { AccessTokenClaims } from './auth.constants';

/**
 * Test-only: an `Authorization` header for an existing user, signed like a real login (pass `app.get(JwtService)`).
 * HTTP tests (e.g. the `http` entries of tenant-isolation.matrix.ts) call endpoints as a seeded user without going
 * through login, its rate limit and lockout. JwtAuthGuard still reloads the user, so the row must exist and be active.
 */
export function bearerFor(jwt: JwtService, user: { userId: string; officeId: string; role: string }): { Authorization: string } {
  const claims: AccessTokenClaims = { sub: user.userId, officeId: user.officeId, role: user.role, sid: 'test-session' };
  const token = jwt.sign(claims, {
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    algorithm: 'HS256',
  });
  return { Authorization: `Bearer ${token}` };
}
