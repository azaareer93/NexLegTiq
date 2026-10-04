import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';

import { AppException, PermissionDeniedException } from '../../common/errors/app.exception';
import { AppConfig } from '../../config/app-config';
import { testEnv } from '../../config/env.fixture';
import { parseEnv } from '../../config/env.schema';
import type { PrismaService } from '../../database/prisma.service';
import { hashOpaqueToken, newOpaqueToken } from '../../common/auth/opaque-token';
import { Public } from '../../common/auth/public.decorator';
import { JWT_AUDIENCE, JWT_ISSUER } from './auth.constants';
import { assertCookieRequestOrigin } from './csrf';
import { bearerFor } from './auth.test-helper';
import { JwtAuthGuard } from './jwt-auth.guard';
import { isLocked, lockedUntil } from './lockout';
import { PasswordHasher } from './password-hasher';
import { refreshCookieOptions, refreshExpiry, rotatedExpiry } from './refresh-token';

const SECRET = 'unit-test-only-jwt-secret-0123456789abcdef';
const OFFICE = '01920000-0000-7000-8000-00000000000a';
const USER = '01920000-0000-7000-8000-0000000000aa';

/** alg:none token with valid claims: must be refused whatever its payload says. */
function unsigned(): string {
  const part = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return `${part({ alg: 'none', typ: 'JWT' })}.${part({ sub: USER, officeId: OFFICE, iss: JWT_ISSUER, aud: JWT_AUDIENCE, iat: now, exp: now + 900 })}.`;
}

describe('refresh tokens and cookie', () => {
  it('should create opaque 32-byte tokens and store only their SHA-256', () => {
    const token = newOpaqueToken();
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(newOpaqueToken()).not.toBe(token);
    expect(hashOpaqueToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashOpaqueToken(token)).not.toContain(token);
  });

  it('should last 7 days, or 30 with remember me', () => {
    const now = new Date('2026-10-01T00:00:00Z');
    expect(refreshExpiry(now, false).toISOString()).toBe('2026-10-08T00:00:00.000Z');
    expect(refreshExpiry(now, true).toISOString()).toBe('2026-10-31T00:00:00.000Z');
  });

  it('should keep the lifetime on rotation, capped at 90 days from the session start', () => {
    const now = new Date('2026-10-01T00:00:00Z');
    const previous = { createdAt: new Date('2026-09-30T00:00:00Z'), expiresAt: new Date('2026-10-07T00:00:00Z') };
    expect(rotatedExpiry(now, previous, previous.createdAt).toISOString()).toBe('2026-10-08T00:00:00.000Z');
    const started = new Date('2026-07-05T00:00:00Z');
    expect(rotatedExpiry(now, previous, started).toISOString()).toBe('2026-10-03T00:00:00.000Z');
  });

  it('should set an httpOnly Secure SameSite=Lax cookie scoped to /api/v1/auth (D-050)', () => {
    expect(refreshCookieOptions()).toEqual({ httpOnly: true, secure: true, sameSite: 'lax', path: '/api/v1/auth' });
  });
});

describe('lockout (D-053)', () => {
  const at = (minutes: number): Date => new Date(Date.UTC(2026, 9, 1, 12, minutes));
  const failures = (...minutes: number[]): Date[] => minutes.map(at);

  it('should lock for 15 minutes from the newest of 5 failures within 15 minutes', () => {
    const recent = failures(14, 10, 5, 2, 0);
    expect(lockedUntil(recent)).toEqual(at(29));
    expect(isLocked(recent, at(28))).toBe(true);
    expect(isLocked(recent, at(29))).toBe(false);
  });

  it('should not lock with fewer than 5 failures or when they span more than 15 minutes', () => {
    expect(lockedUntil(failures(4, 3, 2, 1))).toBeNull();
    expect(lockedUntil(failures(16, 10, 5, 2, 0))).toBeNull();
  });
});

describe('assertCookieRequestOrigin (D-055)', () => {
  const allowed = ['http://localhost:4200'];

  it('should accept an allowed origin with X-Requested-With', () => {
    expect(() =>
      assertCookieRequestOrigin({ origin: 'http://localhost:4200', 'x-requested-with': 'XMLHttpRequest' }, allowed),
    ).not.toThrow();
  });

  it.each([
    ['no origin', { 'x-requested-with': 'XMLHttpRequest' }],
    ['a foreign origin', { origin: 'https://evil.test', 'x-requested-with': 'XMLHttpRequest' }],
    ['no X-Requested-With', { origin: 'http://localhost:4200' }],
    ['another X-Requested-With', { origin: 'http://localhost:4200', 'x-requested-with': 'fetch' }],
  ])('should reject %s with 403 AUTH-100', (_label, headers) => {
    expect(() => assertCookieRequestOrigin(headers, allowed)).toThrow(PermissionDeniedException);
  });
});

describe('PasswordHasher (Argon2id)', () => {
  const hasher = new PasswordHasher();

  it('should hash with Argon2id at the OWASP parameters and verify', async () => {
    const hash = await hasher.hash('correct horse battery');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    await expect(hasher.verify(hash, 'correct horse battery')).resolves.toBe(true);
    await expect(hasher.verify(hash, 'wrong')).resolves.toBe(false);
  });

  it('should answer false for unknown users and malformed hashes without throwing', async () => {
    await expect(hasher.verify(undefined, 'anything')).resolves.toBe(false);
    await expect(hasher.verify('!', 'anything')).resolves.toBe(false);
    await expect(hasher.verify('$2b$10$notargon', 'anything')).resolves.toBe(false);
  });
});

describe('JwtAuthGuard', () => {
  const jwt = new JwtService({ secret: SECRET });
  const sign = (claims: object, options: object = {}): string =>
    jwt.sign({ sub: USER, officeId: OFFICE, role: 'LAWYER', sid: 'family', ...claims }, {
      expiresIn: 900,
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      ...options,
    });

  const verified = { emailVerifiedAt: new Date('2026-09-01T00:00:00Z'), createdAt: new Date('2026-09-01T00:00:00Z') };
  function setup(user: unknown = { role: 'LAWYER', isActive: true, ...verified, office: { isActive: true } }) {
    const findFirst = jest.fn().mockResolvedValue(user);
    const prisma = { unscoped: () => ({ user: { findFirst } }) } as unknown as PrismaService;
    const guard = new JwtAuthGuard(new Reflector(), jwt, prisma, new AppConfig(parseEnv(testEnv({ EMAIL_VERIFICATION_ENFORCED: 'true' }))));
    const request: { headers: Record<string, string>; user?: unknown } = { headers: {} };
    const run = (authorization?: string, handler: object = () => undefined): Promise<boolean> => {
      if (authorization) request.headers['authorization'] = authorization;
      return guard.canActivate({
        getHandler: () => handler,
        getClass: () => class {},
        switchToHttp: () => ({ getRequest: () => request }),
      } as unknown as ExecutionContext);
    };
    return { run, request, findFirst };
  }

  it('should let @Public() routes through without a token', async () => {
    class Open {
      @Public()
      handler(): void {
        return undefined;
      }
    }
    const { run } = setup();
    await expect(run(undefined, Open.prototype.handler)).resolves.toBe(true);
  });

  it('should accept the header built by the bearerFor test helper', async () => {
    const { run } = setup();
    await expect(run(bearerFor(jwt, { userId: USER, officeId: OFFICE, role: 'LAWYER' }).Authorization)).resolves.toBe(true);
  });

  it('should authenticate a valid token and reload the role from the database', async () => {
    const { run, request, findFirst } = setup({ role: 'SENIOR_LAWYER', isActive: true, ...verified, office: { isActive: true } });
    await expect(run(`Bearer ${sign({ role: 'TRAINEE' })}`)).resolves.toBe(true);
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: USER, officeId: OFFICE } }));
    expect(request.user).toEqual({ userId: USER, officeId: OFFICE, role: 'SENIOR_LAWYER', realm: 'OFFICE', sessionId: 'family' });
  });

  it.each([
    ['no token', undefined, 'AUTH-003'],
    ['a malformed header', 'Token abc', 'AUTH-003'],
    ['an unsigned alg:none token', `Bearer ${unsigned()}`, 'AUTH-003'],
    ['an HS512 token', `Bearer ${jwt.sign({ sub: USER, officeId: OFFICE }, { algorithm: 'HS512', issuer: JWT_ISSUER, audience: JWT_AUDIENCE })}`, 'AUTH-003'],
    ['a forged signature', `Bearer ${new JwtService({ secret: 'x'.repeat(40) }).sign({ sub: USER }, { issuer: JWT_ISSUER, audience: JWT_AUDIENCE })}`, 'AUTH-003'],
  ])('should answer 401 for %s', async (_label, header, code) => {
    const { run } = setup();
    await expect(run(header)).rejects.toMatchObject({ code });
  });

  it('should answer 401 AUTH-002 for an expired token and AUTH-003 for the wrong audience or issuer', async () => {
    await expect(setup().run(`Bearer ${sign({}, { issuer: 'someone-else' })}`)).rejects.toMatchObject({ code: 'AUTH-003' });
    await expect(setup().run(`Bearer ${sign({}, { expiresIn: -10 })}`)).rejects.toMatchObject({ code: 'AUTH-002' });
    await expect(setup().run(`Bearer ${sign({}, { audience: 'portal' })}`)).rejects.toMatchObject({ code: 'AUTH-003' });
  });

  it.each([
    ['a user that no longer exists (or moved office)', null, 'AUTH-003', 'Invalid or missing access token'],
    ['an inactive user', { role: 'LAWYER', isActive: false, ...verified, office: { isActive: true } }, 'AUTH-006', 'User account is inactive'],
    ['a suspended office', { role: 'LAWYER', isActive: true, ...verified, office: { isActive: false } }, 'AUTH-006', 'Office is suspended'],
    ['an unknown role', { role: 'GHOST', isActive: true, ...verified, office: { isActive: true } }, 'AUTH-003', 'Invalid or missing access token'],
    [
      'an email unverified 7 days after signup',
      { role: 'LAWYER', isActive: true, emailVerifiedAt: null, createdAt: new Date(Date.now() - 8 * 86_400_000), office: { isActive: true } },
      'AUTH-010',
      'Email address not verified',
    ],
  ])('should refuse %s', async (_label, user, code, message) => {
    const { run } = setup(user);
    const error = await run(`Bearer ${sign({})}`).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AppException);
    expect(error).toMatchObject({ code, message });
  });
});
