import { randomUUID } from 'node:crypto';

import { Controller, Get, Module } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import request from 'supertest';

import { configureApp } from '../../app/configure-app';
import { AppModule } from '../../app/app.module';
import { RequirePermissions } from '../../common/rbac/permissions.decorator';
import { testEnv } from '../../config/env.fixture';
import { PrismaService } from '../../database/prisma.service';
import { REFRESH_COOKIE } from './refresh-token';
import { PasswordHasher } from './password-hasher';

@Controller('__auth_probe__')
class ProbeController {
  @Get('me')
  me(): { ok: true } {
    return { ok: true };
  }

  @RequirePermissions('manage:users')
  @Get('managers')
  managers(): { ok: true } {
    return { ok: true };
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule {}

const PASSWORD = 'Correct-Horse-9';
const ORIGIN = 'http://localhost:4200';
const csrf = { Origin: ORIGIN, 'X-Requested-With': 'XMLHttpRequest' };

async function createApp(options: { throttle: boolean }): Promise<NestExpressApplication> {
  let builder = Test.createTestingModule({ imports: [AppModule, ProbeModule] });
  if (!options.throttle) builder = builder.overrideProvider(ThrottlerGuard).useValue({ canActivate: () => true });
  const app = (await builder.compile()).createNestApplication<NestExpressApplication>({ bufferLogs: true });
  configureApp(app);
  await app.init();
  return app;
}

function refreshCookie(res: request.Response): string | undefined {
  const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  return cookies.find((cookie) => cookie.startsWith(`${REFRESH_COOKIE}=`));
}
const cookieValue = (cookie: string | undefined): string => (cookie ?? '').split(';')[0] ?? '';

/**
 * MVP-40 on real PostgreSQL through HTTP: login, Bearer access, rotation, reuse detection, logout, CSRF, inactive users,
 * suspended offices, lockout and rate limits (D-050, D-053, D-055, D-081, D-082).
 */
describe('auth (HTTP + PostgreSQL)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const officeIds: string[] = [];
  const emails: string[] = [];

  async function seedUser(options: { role?: 'LAWYER' | 'OFFICE_MANAGER'; isActive?: boolean; officeActive?: boolean } = {}) {
    const raw = prisma.unscoped();
    const office = await raw.office.create({ data: { name: 'Auth test office', isActive: options.officeActive ?? true } });
    officeIds.push(office.id);
    const email = `auth-${randomUUID()}@example.test`;
    emails.push(email);
    const user = await raw.user.create({
      data: {
        officeId: office.id,
        fullName: 'Auth Test',
        email,
        passwordHash: await new PasswordHasher().hash(PASSWORD),
        role: options.role ?? 'LAWYER',
        isActive: options.isActive ?? true,
      },
    });
    return { officeId: office.id, userId: user.id, email };
  }

  const login = (email: string, password = PASSWORD, rememberMe = false) =>
    request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password, rememberMe });
  const refresh = (cookie: string) => request(app.getHttpServer()).post('/api/v1/auth/refresh').set('Cookie', cookie).set(csrf);
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    // Real database from the environment; every other required variable from the test fixture (TRUST_PROXY_HOPS=1, so
    // X-Forwarded-For sets the client IP).
    Object.assign(process.env, testEnv({ DATABASE_URL: process.env['DATABASE_URL'], NODE_ENV: 'test', CORS_ORIGINS: ORIGIN, METRICS_ENABLED: 'false' }));
    // (metrics off: two app instances in this file would both bind the metrics port)
    app = await createApp({ throttle: false });
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    const raw = prisma.unscoped();
    const where = { officeId: { in: officeIds } };
    await raw.auditLog.deleteMany({ where });
    await raw.refreshToken.deleteMany({ where });
    await raw.user.deleteMany({ where });
    await raw.office.deleteMany({ where: { id: { in: officeIds } } });
    await raw.loginAttempt.deleteMany({ where: { email: { in: emails } } });
    await app.close();
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  });

  describe('login', () => {
    it('should return the session, set the refresh cookie and record the login', async () => {
      const { email, userId, officeId } = await seedUser();
      const res = await login(email.toUpperCase()).expect(200);

      expect(res.body.data).toMatchObject({
        expiresIn: 900,
        user: { id: userId, email, role: 'LAWYER', officeId, officeName: 'Auth test office' },
      });
      expect(res.body.data.user.permissions).toEqual(expect.arrayContaining(['create:case', 'use:ai']));
      expect(res.body.data.user.permissions).not.toContain('manage:users');
      const cookie = refreshCookie(res) ?? '';
      expect(cookie).toMatch(/HttpOnly/);
      expect(cookie).toMatch(/Secure/);
      expect(cookie).toMatch(/SameSite=Lax/);
      expect(cookie).toMatch(/Path=\/api\/v1\/auth/);
      expect(JSON.stringify(res.body)).not.toContain(cookieValue(cookie).split('=')[1]);

      const raw = prisma.unscoped();
      await expect(raw.user.findUniqueOrThrow({ where: { id: userId } })).resolves.toMatchObject({ lastLoginAt: expect.any(Date) });
      await expect(raw.auditLog.count({ where: { officeId, action: 'LOGIN', userId } })).resolves.toBe(1);
      await expect(raw.loginAttempt.count({ where: { email, success: true } })).resolves.toBe(1);
    });

    it('should keep the refresh cookie 30 days with remember me, 7 otherwise', async () => {
      const { email } = await seedUser();
      const days = (res: request.Response): number =>
        Math.round((Date.parse(/Expires=([^;]+)/.exec(refreshCookie(res) ?? '')?.[1] ?? '') - Date.now()) / 86_400_000);
      expect(days(await login(email).expect(200))).toBe(7);
      expect(days(await login(email, PASSWORD, true).expect(200))).toBe(30);
    });

    it('should answer the same 401 AUTH-001 for a wrong password and an unknown email', async () => {
      const { email } = await seedUser();
      const wrong = await login(email, 'nope-nope-1').expect(401);
      const unknown = await login(`ghost-${randomUUID()}@example.test`).expect(401);
      expect(wrong.body.error).toMatchObject({ code: 'AUTH-001' });
      expect(unknown.body.error).toEqual(wrong.body.error);
      await expect(prisma.unscoped().loginAttempt.count({ where: { email, success: false } })).resolves.toBe(1);
      expect(refreshCookie(wrong)).toBeUndefined();
    });

    it('should refuse an inactive user and a suspended office with 403 AUTH-006', async () => {
      const inactive = await seedUser({ isActive: false });
      const suspended = await seedUser({ officeActive: false });
      expect((await login(inactive.email).expect(403)).body.error).toMatchObject({ code: 'AUTH-006', message: 'User account is inactive' });
      expect((await login(suspended.email).expect(403)).body.error).toMatchObject({ code: 'AUTH-006', message: 'Office is suspended' });
    });

    it('should lock an email + IP after 5 failures, even for the right password (D-053)', async () => {
      const { email } = await seedUser();
      for (let i = 0; i < 5; i += 1) await login(email, 'wrong-password-1').expect(401);
      const locked = await login(email).expect(423);
      expect(locked.body.error).toMatchObject({ code: 'AUTH-007' });
    });
  });

  describe('lockout window (D-053)', () => {
    const IP = '203.0.113.7';
    const loginFrom = (ip: string, email: string, password = PASSWORD) => login(email, password).set('X-Forwarded-For', ip);
    async function seedAttempts(email: string, minutesAgo: number[], success = false) {
      await prisma.unscoped().loginAttempt.createMany({
        data: minutesAgo.map((minutes) => ({ email, ipAddress: IP, success, attemptedAt: new Date(Date.now() - minutes * 60_000) })),
      });
    }

    it('should lock only the email + IP pair that failed', async () => {
      const { email } = await seedUser();
      await seedAttempts(email, [1, 2, 3, 4, 5]);
      expect((await loginFrom(IP, email).expect(423)).body.error).toMatchObject({ code: 'AUTH-007' });
      await loginFrom('203.0.113.8', email).expect(200);
    });

    it('should not lock for failures older than 15 minutes or spread over more than 15 minutes', async () => {
      const old = await seedUser();
      await seedAttempts(old.email, [16, 17, 18, 19, 20]);
      await loginFrom(IP, old.email).expect(200);

      const spread = await seedUser();
      await seedAttempts(spread.email, [1, 2, 3, 4, 17]);
      await loginFrom(IP, spread.email).expect(200);
    });

    it('should not count failures before the last successful login', async () => {
      const { email } = await seedUser();
      await seedAttempts(email, [6, 7, 8, 9]);
      await seedAttempts(email, [5], true);
      await seedAttempts(email, [1]);
      await loginFrom(IP, email).expect(200);
    });
  });

  describe('Bearer access', () => {
    it('should accept the access token, refuse without it, and apply role changes on the next request', async () => {
      const { email, userId } = await seedUser({ role: 'OFFICE_MANAGER' });
      const token = (await login(email).expect(200)).body.data.accessToken as string;
      const server = app.getHttpServer();

      await request(server).get('/api/v1/__auth_probe__/me').expect(401);
      await request(server).get('/api/v1/__auth_probe__/me').set('Authorization', `Bearer ${token}`).expect(200);
      await request(server).get('/api/v1/__auth_probe__/managers').set('Authorization', `Bearer ${token}`).expect(200);

      await prisma.unscoped().user.update({ where: { id: userId }, data: { role: 'TRAINEE' } });
      const demoted = await request(server).get('/api/v1/__auth_probe__/managers').set('Authorization', `Bearer ${token}`).expect(403);
      expect(demoted.body.error).toMatchObject({ code: 'AUTH-100' });

      await prisma.unscoped().user.update({ where: { id: userId }, data: { isActive: false } });
      const deactivated = await request(server).get('/api/v1/__auth_probe__/me').set('Authorization', `Bearer ${token}`).expect(403);
      expect(deactivated.body.error).toMatchObject({ code: 'AUTH-006' });
    });
  });

  describe('refresh and logout', () => {
    it('should require the CSRF headers on cookie endpoints (D-055)', async () => {
      const { email } = await seedUser();
      const cookie = cookieValue(refreshCookie(await login(email).expect(200)));
      const server = app.getHttpServer();
      for (const headers of [{}, { Origin: ORIGIN }, { 'X-Requested-With': 'XMLHttpRequest' }, { ...csrf, Origin: 'https://evil.test' }]) {
        const res = await request(server).post('/api/v1/auth/refresh').set('Cookie', cookie).set(headers).expect(403);
        expect(res.body.error).toMatchObject({ code: 'AUTH-100' });
      }
      await request(server).post('/api/v1/auth/logout').set('Cookie', cookie).expect(403);
    });

    it('should rotate the refresh token and link the old one to its replacement', async () => {
      const { email, userId } = await seedUser();
      const first = refreshCookie(await login(email).expect(200));
      const res = await request(app.getHttpServer()).post('/api/v1/auth/refresh').set('Cookie', cookieValue(first)).set(csrf).expect(200);
      const second = refreshCookie(res);

      expect(res.body.data).toMatchObject({ expiresIn: 900, user: { id: userId } });
      expect(cookieValue(second)).not.toBe(cookieValue(first));
      const tokens = await prisma.unscoped().refreshToken.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
      expect(tokens).toHaveLength(2);
      expect(tokens[0]).toMatchObject({ revokedAt: expect.any(Date), replacedById: tokens[1]?.id, familyId: tokens[1]?.familyId });
      expect(tokens[1]).toMatchObject({ revokedAt: null });
    });

    it('should revoke the whole family and audit SECURITY when a rotated token is replayed', async () => {
      const { email, userId, officeId } = await seedUser();
      const server = app.getHttpServer();
      const stolen = cookieValue(refreshCookie(await login(email).expect(200)));
      const current = cookieValue(refreshCookie(await request(server).post('/api/v1/auth/refresh').set('Cookie', stolen).set(csrf).expect(200)));

      const replay = await request(server).post('/api/v1/auth/refresh').set('Cookie', stolen).set(csrf).expect(401);
      expect(replay.body.error).toMatchObject({ code: 'AUTH-005' });
      expect(refreshCookie(replay)).toMatch(/Expires=Thu, 01 Jan 1970/);
      await request(server).post('/api/v1/auth/refresh').set('Cookie', current).set(csrf).expect(401);

      await expect(prisma.unscoped().refreshToken.count({ where: { userId, revokedAt: null } })).resolves.toBe(0);
      const security = await prisma.unscoped().auditLog.findFirstOrThrow({ where: { officeId, action: 'SECURITY' } });
      expect(security.newValues).toMatchObject({ reason: 'REFRESH_TOKEN_REUSE' });
    });

    it('should let exactly one of two concurrent refreshes win and treat the other as reuse', async () => {
      const { email, userId, officeId } = await seedUser();
      const cookie = cookieValue(refreshCookie(await login(email).expect(200)));
      const statuses = (await Promise.all([refresh(cookie), refresh(cookie)])).map((res) => res.status).sort();

      expect(statuses).toEqual([200, 401]);
      await expect(prisma.unscoped().refreshToken.count({ where: { userId, revokedAt: null } })).resolves.toBe(0);
      await expect(prisma.unscoped().auditLog.count({ where: { officeId, action: 'SECURITY' } })).resolves.toBe(1);
    });

    it('should keep the remember-me lifetime across rotation', async () => {
      const { email, userId } = await seedUser();
      const cookie = cookieValue(refreshCookie(await login(email, PASSWORD, true).expect(200)));
      await refresh(cookie).expect(200);
      const latest = await prisma.unscoped().refreshToken.findFirstOrThrow({ where: { userId, revokedAt: null } });
      expect(Math.round((latest.expiresAt.getTime() - Date.now()) / 86_400_000)).toBe(30);
    });

    it('should audit with client details and never store a token in the log', async () => {
      const { email, officeId } = await seedUser();
      const res = await login(email).set('X-Forwarded-For', '198.51.100.4').set('User-Agent', 'jest-agent').set('x-request-id', 'req-audit-0001');
      const token = cookieValue(refreshCookie(res)).split('=')[1] ?? '';
      const row = await prisma.unscoped().auditLog.findFirstOrThrow({ where: { officeId, action: 'LOGIN' } });

      expect(row).toMatchObject({ ipAddress: '198.51.100.4', userAgent: 'jest-agent', requestId: 'req-audit-0001' });
      const stored = JSON.stringify(row);
      expect(stored).not.toContain(token);
      expect(stored).not.toContain(res.body.data.accessToken);
    });

    it('should answer 401 AUTH-004 for an expired refresh token and AUTH-005 for an unknown one', async () => {
      const { email, userId } = await seedUser();
      const cookie = cookieValue(refreshCookie(await login(email).expect(200)));
      await prisma.unscoped().refreshToken.updateMany({ where: { userId }, data: { expiresAt: new Date(Date.now() - 1000) } });
      const server = app.getHttpServer();

      expect((await request(server).post('/api/v1/auth/refresh').set('Cookie', cookie).set(csrf).expect(401)).body.error).toMatchObject({
        code: 'AUTH-004',
      });
      expect(
        (await request(server).post('/api/v1/auth/refresh').set('Cookie', `${REFRESH_COOKIE}=nope`).set(csrf).expect(401)).body.error,
      ).toMatchObject({ code: 'AUTH-005' });
    });

    it('should revoke the family on logout, clear the cookie and audit LOGOUT', async () => {
      const { email, userId, officeId } = await seedUser();
      const server = app.getHttpServer();
      const cookie = cookieValue(refreshCookie(await login(email).expect(200)));

      const res = await request(server).post('/api/v1/auth/logout').set('Cookie', cookie).set(csrf).expect(204);
      expect(refreshCookie(res)).toMatch(/Expires=Thu, 01 Jan 1970/);
      await expect(prisma.unscoped().refreshToken.count({ where: { userId, revokedAt: null } })).resolves.toBe(0);
      await expect(prisma.unscoped().auditLog.count({ where: { officeId, action: 'LOGOUT' } })).resolves.toBe(1);
      await request(server).post('/api/v1/auth/refresh').set('Cookie', cookie).set(csrf).expect(401);
      await request(server).post('/api/v1/auth/logout').set(csrf).expect(204);
      // A second logout with the same cookie is a no-op: no second audit row.
      await request(server).post('/api/v1/auth/logout').set('Cookie', cookie).set(csrf).expect(204);
      await expect(prisma.unscoped().auditLog.count({ where: { officeId, action: 'LOGOUT' } })).resolves.toBe(1);
    });

    it('should end the session when the user was deactivated since login', async () => {
      const { email, userId } = await seedUser();
      const cookie = cookieValue(refreshCookie(await login(email).expect(200)));
      await prisma.unscoped().user.update({ where: { id: userId }, data: { isActive: false } });

      const res = await request(app.getHttpServer()).post('/api/v1/auth/refresh').set('Cookie', cookie).set(csrf).expect(403);
      expect(res.body.error).toMatchObject({ code: 'AUTH-006' });
      await expect(prisma.unscoped().refreshToken.count({ where: { userId, revokedAt: null } })).resolves.toBe(0);
    });
  });

  describe('rate limits', () => {
    let limited: INestApplication;

    beforeAll(async () => {
      limited = await createApp({ throttle: true });
    });

    afterAll(async () => {
      await limited?.close();
    });

    it('should allow 5 logins a minute per client and answer 429 RATE-001 after that', async () => {
      const email = `rate-${randomUUID()}@example.test`;
      emails.push(email);
      const attempt = () => request(limited.getHttpServer()).post('/api/v1/auth/login').send({ email, password: 'x' });
      for (let i = 0; i < 5; i += 1) await attempt().expect(401);
      const blocked = await attempt().expect(429);
      expect(blocked.body.error).toMatchObject({ code: 'RATE-001' });
      expect(blocked.headers['retry-after']).toBeDefined();
    });

    it('should allow 30 refreshes a minute per client', async () => {
      const attempt = () =>
        request(limited.getHttpServer()).post('/api/v1/auth/refresh').set('X-Forwarded-For', '192.0.2.30').set(csrf);
      for (let i = 0; i < 30; i += 1) await attempt().expect(401);
      expect((await attempt().expect(429)).body.error).toMatchObject({ code: 'RATE-001' });
    });
  });
});
