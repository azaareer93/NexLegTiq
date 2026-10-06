import { JwtService } from '@nestjs/jwt';
import type { Request, Response } from 'express';
import { ClsServiceManager } from 'nestjs-cls';

import { hashOpaqueToken } from '../../common/auth/opaque-token';
import type { RequestContext } from '../../common/context/request-context';
import { AppException } from '../../common/errors/app.exception';
import { TenantRunner } from '../../common/tenancy/tenant-runner';
import { AppConfig } from '../../config/app-config';
import { testEnv } from '../../config/env.fixture';
import { parseEnv } from '../../config/env.schema';
import type { PrismaService } from '../../database/prisma.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import type { IssuedSession } from './auth.service';
import type { ClientInfo } from './client-info';
import { LoginAttemptRepository } from './login-attempt.repository';
import type { PasswordHasher } from './password-hasher';
import { REFRESH_COOKIE } from './refresh-token';
import { RefreshTokenRepository } from './refresh-token.repository';
import type { SignupService } from './signup.service';

const OFFICE = '01920000-0000-7000-8000-00000000000a';
const USER = '01920000-0000-7000-8000-0000000000aa';
const client: ClientInfo = { ip: '10.0.0.1', userAgent: 'jest', requestId: 'req-12345678' };
const cls = ClsServiceManager.getClsService<RequestContext>();

const activeUser = {
  id: USER,
  officeId: OFFICE,
  fullName: 'Lawyer',
  email: 'lawyer@example.test',
  role: 'LAWYER',
  uiLanguage: 'AR',
  isActive: true,
  emailVerifiedAt: new Date('2026-09-01T00:00:00Z'),
  createdAt: new Date('2026-09-01T00:00:00Z'),
  office: { name: 'Office', isActive: true },
};

function setup(
  overrides: {
    user?: unknown;
    token?: unknown;
    failures?: Date[];
    valid?: boolean;
    claimed?: number;
    familyStartedAt?: Date;
    enforced?: boolean;
  } = {},
) {
  // One mock serves as the scoped client and as every transaction opened on it.
  const db = {
    user: { update: jest.fn().mockResolvedValue({}) },
    refreshToken: {
      updateMany: jest.fn().mockResolvedValue({ count: overrides.claimed ?? 1 }),
      create: jest.fn().mockResolvedValue({ id: 'next', familyId: 'family' }),
      update: jest.fn().mockResolvedValue({}),
      findFirst: jest
        .fn()
        .mockResolvedValue({ createdAt: overrides.familyStartedAt ?? new Date(Date.now() - 1000) }),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
  const raw = {
    user: {
      findUnique: jest
        .fn()
        .mockResolvedValue(
          overrides.user === undefined ? { ...activeUser, passwordHash: 'h' } : overrides.user,
        ),
    },
    refreshToken: { findUnique: jest.fn().mockResolvedValue(overrides.token ?? null) },
    loginAttempt: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest
        .fn()
        .mockResolvedValue((overrides.failures ?? []).map((attemptedAt) => ({ attemptedAt }))),
      create: jest.fn().mockResolvedValue({}),
    },
  };
  const scoped = { ...db, $transaction: jest.fn((work: (t: typeof db) => unknown) => work(db)) };
  const prisma = { db: scoped, unscoped: () => raw } as unknown as PrismaService;
  const passwords = {
    verify: jest.fn().mockResolvedValue(overrides.valid ?? true),
  } as unknown as PasswordHasher;
  const service = new AuthService(
    prisma,
    new TenantRunner(cls),
    new JwtService({ secret: 'x'.repeat(40) }),
    passwords,
    new RefreshTokenRepository(prisma),
    new LoginAttemptRepository(prisma),
    new AppConfig(
      parseEnv(testEnv({ EMAIL_VERIFICATION_ENFORCED: String(overrides.enforced ?? true) })),
    ),
  );
  return { service, db, raw };
}

const request = { email: 'lawyer@example.test', password: 'pw', rememberMe: false };
const storedToken = (extra: object = {}) => ({
  id: 'old',
  familyId: 'family',
  createdAt: new Date(Date.now() - 1000),
  expiresAt: new Date(Date.now() + 86_400_000),
  revokedAt: null,
  user: activeUser,
  ...extra,
});

describe('AuthService.login', () => {
  it('should issue a session, record the attempt, update lastLoginAt and audit LOGIN', async () => {
    const { service, db, raw } = setup();
    const issued = await service.login(request, client);

    expect(issued.session).toMatchObject({
      expiresIn: 900,
      user: { id: USER, officeName: 'Office' },
    });
    expect(issued.session.user.permissions).toContain('create:case');
    expect(raw.loginAttempt.create).toHaveBeenCalledWith({
      data: { email: request.email, ipAddress: '10.0.0.1', success: true },
    });
    expect(db.user.update).toHaveBeenCalled();
    expect(db.refreshToken.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        officeId: OFFICE,
        userId: USER,
        tokenHash: hashOpaqueToken(issued.refreshToken),
      }),
    });
    expect(db.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'LOGIN', requestId: 'req-12345678' }),
    });
  });

  it('should lock out before checking the password', async () => {
    const { service, raw } = setup({
      failures: Array.from({ length: 5 }, () => new Date(Date.now() - 1000)),
    });
    await expect(service.login(request, client)).rejects.toMatchObject({ code: 'AUTH-007' });
    expect(raw.user.findUnique).not.toHaveBeenCalled();
  });

  it.each([
    ['a wrong password', { valid: false }],
    ['an unknown email', { user: null, valid: false }],
  ])('should answer AUTH-001 for %s and record a failure', async (_label, overrides) => {
    const { service, raw } = setup(overrides);
    await expect(service.login(request, client)).rejects.toMatchObject({ code: 'AUTH-001' });
    expect(raw.loginAttempt.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ success: false }),
    });
  });

  it.each([
    ['an inactive user', { ...activeUser, isActive: false }, 'User account is inactive'],
    [
      'a suspended office',
      { ...activeUser, office: { name: 'O', isActive: false } },
      'Office is suspended',
    ],
    ['an unknown role', { ...activeUser, role: 'GHOST' }, 'User account is inactive'],
  ])('should refuse %s with AUTH-006', async (_label, user, message) => {
    const { service } = setup({ user: { ...user, passwordHash: 'h' } });
    await expect(service.login(request, client)).rejects.toMatchObject({
      code: 'AUTH-006',
      message,
    });
  });

  it('should log in an unverified user within 7 days and say until when, then refuse with AUTH-010', async () => {
    const fresh = {
      ...activeUser,
      emailVerifiedAt: null,
      createdAt: new Date(Date.now() - 86_400_000),
      passwordHash: 'h',
    };
    const issued = await setup({ user: fresh }).service.login(request, client);
    expect(issued.session.user).toMatchObject({
      emailVerified: false,
      verifyBy: new Date(fresh.createdAt.getTime() + 7 * 86_400_000).toISOString(),
    });

    const overdue = { ...fresh, createdAt: new Date(Date.now() - 8 * 86_400_000) };
    const { service, raw } = setup({ user: overdue });
    await expect(service.login(request, client)).rejects.toMatchObject({ code: 'AUTH-010' });
    // The password was right: the attempt counts as a success, so retries never turn AUTH-010 into a lockout.
    expect(raw.loginAttempt.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ success: true }),
    });
  });

  it('should not block an overdue verification while EMAIL_VERIFICATION_ENFORCED is off', async () => {
    const overdue = {
      ...activeUser,
      emailVerifiedAt: null,
      createdAt: new Date(Date.now() - 8 * 86_400_000),
      passwordHash: 'h',
    };
    const issued = await setup({ user: overdue, enforced: false }).service.login(request, client);
    expect(issued.session.user.emailVerified).toBe(false);
  });
});

describe('AuthService.refresh', () => {
  it('should rotate: claim the old token, create the next in the same family and link them', async () => {
    const { service, db } = setup({ token: storedToken() });
    const issued = await service.refresh('cookie', client);

    expect(db.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { id: 'old', revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(db.refreshToken.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ officeId: OFFICE, familyId: 'family' }),
    });
    expect(db.refreshToken.update).toHaveBeenCalledWith({
      where: { id: 'old' },
      data: { replacedById: 'next' },
    });
    // The user row is locked before the claim, so a concurrent password reset cannot miss the new token (D-086).
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
    expect(db.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      db.refreshToken.updateMany.mock.invocationCallOrder[0] ?? 0,
    );
    expect(issued.session.user.id).toBe(USER);
  });

  it('should answer AUTH-005 for a missing or unknown token', async () => {
    await expect(setup().service.refresh(undefined, client)).rejects.toMatchObject({
      code: 'AUTH-005',
    });
    await expect(setup().service.refresh('unknown', client)).rejects.toMatchObject({
      code: 'AUTH-005',
    });
  });

  it('should treat a revoked token as reuse: revoke the family and audit SECURITY', async () => {
    const { service, db } = setup({ token: storedToken({ revokedAt: new Date() }) });
    await expect(service.refresh('cookie', client)).rejects.toMatchObject({ code: 'AUTH-005' });
    expect(db.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { familyId: 'family', revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(db.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'SECURITY' }),
    });
  });

  it('should treat losing the concurrent claim as reuse', async () => {
    const { service, db } = setup({ token: storedToken(), claimed: 0 });
    await expect(service.refresh('cookie', client)).rejects.toMatchObject({ code: 'AUTH-005' });
    expect(db.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'SECURITY' }),
    });
  });

  it('should answer AUTH-004 for an expired token', async () => {
    const { service } = setup({ token: storedToken({ expiresAt: new Date(Date.now() - 1) }) });
    await expect(service.refresh('cookie', client)).rejects.toMatchObject({ code: 'AUTH-004' });
  });

  it('should keep the token lifetime across rotation but end the session 90 days after login', async () => {
    const remembered = storedToken({
      createdAt: new Date(Date.now() - 1000),
      expiresAt: new Date(Date.now() + 30 * 86_400_000 - 1000),
    });
    const fresh = await setup({ token: remembered }).service.refresh('cookie', client);
    expect(fresh.refreshExpiresAt.getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);

    const old = setup({
      token: remembered,
      familyStartedAt: new Date(Date.now() - 91 * 86_400_000),
    });
    await expect(old.service.refresh('cookie', client)).rejects.toMatchObject({ code: 'AUTH-004' });
    expect(old.db.refreshToken.create).not.toHaveBeenCalled();
  });

  it('should refuse an overdue verification with AUTH-010 and end the session', async () => {
    const overdue = {
      ...activeUser,
      emailVerifiedAt: null,
      createdAt: new Date(Date.now() - 8 * 86_400_000),
    };
    const { service, db } = setup({ token: storedToken({ user: overdue }) });
    await expect(service.refresh('cookie', client)).rejects.toMatchObject({ code: 'AUTH-010' });
    expect(db.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { familyId: 'family', revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it('should revoke the family and refuse when the user was deactivated', async () => {
    const { service, db } = setup({
      token: storedToken({ user: { ...activeUser, isActive: false } }),
    });
    await expect(service.refresh('cookie', client)).rejects.toMatchObject({ code: 'AUTH-006' });
    expect(db.refreshToken.updateMany).toHaveBeenCalled();
  });
});

describe('AuthService.logout', () => {
  it('should revoke the family and audit LOGOUT, and do nothing without a known token', async () => {
    const found = setup({ token: storedToken() });
    await found.service.logout('cookie', client);
    expect(found.db.refreshToken.updateMany).toHaveBeenCalled();
    expect(found.db.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'LOGOUT' }),
    });

    const missing = setup();
    await missing.service.logout(undefined, client);
    expect(missing.db.auditLog.create).not.toHaveBeenCalled();

    const again = setup({ token: storedToken({ revokedAt: new Date() }) });
    await again.service.logout('cookie', client);
    expect(again.db.auditLog.create).not.toHaveBeenCalled();
  });
});

describe('AuthController', () => {
  const issued: IssuedSession = {
    refreshToken: 'opaque',
    refreshExpiresAt: new Date('2030-01-01T00:00:00Z'),
    session: { accessToken: 'a', expiresIn: 900, user: {} as IssuedSession['session']['user'] },
  };
  const config = new AppConfig(parseEnv(testEnv({ CORS_ORIGINS: 'http://localhost:4200' })));
  const csrf = { origin: 'http://localhost:4200', 'x-requested-with': 'XMLHttpRequest' };
  const req = (headers: object = csrf, cookies: object = { [REFRESH_COOKIE]: 'opaque' }) =>
    ({ headers, cookies, ip: undefined, get: () => undefined }) as unknown as Request;
  const res = () =>
    ({ cookie: jest.fn(), clearCookie: jest.fn() }) as unknown as Response & {
      cookie: jest.Mock;
      clearCookie: jest.Mock;
    };

  function controller(auth: Partial<AuthService>): AuthController {
    return new AuthController(auth as AuthService, {} as SignupService, config, cls);
  }

  it('should set the refresh cookie and return only the session body on login', async () => {
    const login = jest.fn().mockResolvedValue(issued);
    const response = res();
    await expect(
      controller({ login }).login(
        { email: 'e@x.test', password: 'p', rememberMe: false },
        req(),
        response,
      ),
    ).resolves.toBe(issued.session);
    expect(response.cookie).toHaveBeenCalledWith(
      REFRESH_COOKIE,
      'opaque',
      expect.objectContaining({ httpOnly: true }),
    );
    expect(login).toHaveBeenCalledWith(expect.anything(), {
      ip: '0.0.0.0',
      userAgent: null,
      requestId: null,
    });
  });

  it('should clear the cookie when the session is dead, and pass non-string cookies as missing', async () => {
    const refresh = jest.fn().mockRejectedValue(new AppException('AUTH-005', 'refused'));
    const response = res();
    await expect(
      controller({ refresh }).refresh(req(csrf, { [REFRESH_COOKIE]: 42 }), response),
    ).rejects.toThrow('refused');
    expect(refresh).toHaveBeenCalledWith(undefined, expect.anything());
    expect(response.clearCookie).toHaveBeenCalledWith(
      REFRESH_COOKIE,
      expect.objectContaining({ path: '/api/v1/auth' }),
    );
  });

  it('should keep the cookie when a refresh fails for another reason (outage, rate limit)', async () => {
    const response = res();
    const refresh = jest.fn().mockRejectedValue(new AppException('DB-001', 'down'));
    await expect(controller({ refresh }).refresh(req(), response)).rejects.toThrow('down');
    expect(response.clearCookie).not.toHaveBeenCalled();
  });

  it('should rotate the cookie on refresh and clear it on logout', async () => {
    const response = res();
    await controller({ refresh: jest.fn().mockResolvedValue(issued) }).refresh(req(), response);
    expect(response.cookie).toHaveBeenCalled();

    const logoutResponse = res();
    await controller({ logout: jest.fn().mockResolvedValue(undefined) }).logout(
      req(),
      logoutResponse,
    );
    expect(logoutResponse.clearCookie).toHaveBeenCalled();
  });

  it('should reject cookie endpoints without the CSRF headers before touching the session', async () => {
    const refresh = jest.fn();
    await expect(controller({ refresh }).refresh(req({}), res())).rejects.toMatchObject({
      code: 'AUTH-100',
    });
    expect(refresh).not.toHaveBeenCalled();
  });
});
