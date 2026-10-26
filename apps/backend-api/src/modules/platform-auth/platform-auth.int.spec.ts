import { randomUUID } from 'node:crypto';

import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import request from 'supertest';

import { ADMIN_REFRESH_COOKIE } from './platform-auth.constants';
import { totpCode, totpStep } from './totp';
import { AppModule } from '../../app/app.module';
import { configureApp } from '../../app/configure-app';
import { integrationEnv } from '../../config/env.fixture';
import { PrismaService } from '../../database/prisma.service';
import type { PrismaClient } from '../../generated/prisma/client';
import { PasswordHasher } from '../auth/password-hasher';

const PASSWORD = 'Admin-Correct-Horse-9';
const ORIGIN = 'http://localhost:4200';
const csrf = { Origin: ORIGIN, 'X-Requested-With': 'XMLHttpRequest' };

const refreshCookie = (res: request.Response): string => {
  const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  return (cookies.find((c) => c.startsWith(`${ADMIN_REFRESH_COOKIE}=`)) ?? '').split(';')[0] ?? '';
};

/** The platform admin realm (D-145) on real PostgreSQL: enrolment, codes, sessions, the realm boundary and the audit log. */
describe('platform admin auth (HTTP + PostgreSQL)', () => {
  let app: NestExpressApplication;
  let raw: PrismaClient;
  const savedEnv = { ...process.env };
  const emails: string[] = [];
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    Object.assign(process.env, integrationEnv(), {
      ADMIN_JWT_SECRET: 'integration-only-admin-secret-0123456789abcdef',
      // Supertest calls from the loopback: the allow-list is applied and lets them through (blocking: admin-guards.spec).
      ADMIN_IP_ALLOWLIST: '127.0.0.1, ::1',
      CORS_ORIGINS: ORIGIN,
    });
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = module.createNestApplication<NestExpressApplication>({ bufferLogs: true });
    configureApp(app);
    await app.init();
    // unscoped: platform admins are global fixtures.
    raw = app.get(PrismaService).unscoped();
  });

  afterAll(async () => {
    if (!raw) return; // the app did not start: nothing was created
    const admins = await raw.platformAdmin.findMany({ where: { email: { in: emails } } });
    const ids = admins.map((a) => a.id);
    await raw.platformAuditLog.deleteMany({ where: { adminId: { in: ids } } });
    await raw.platformAdmin.deleteMany({ where: { id: { in: ids } } });
    await raw.loginAttempt.deleteMany({ where: { email: { in: emails } } });
    await app?.close();
    process.env = savedEnv;
  });

  async function newAdmin(): Promise<{ id: string; email: string }> {
    const email = `admin-${randomUUID()}@example.test`;
    emails.push(email);
    const admin = await raw.platformAdmin.create({
      data: {
        email,
        fullName: 'Platform Admin',
        passwordHash: await new PasswordHasher().hash(PASSWORD),
      },
    });
    return { id: admin.id, email };
  }

  /** Enrols an admin through the API; returns its secret, first session and recovery codes. */
  async function enrolled() {
    const admin = await newAdmin();
    const { body } = await http()
      .post('/api/v1/admin/auth/enroll')
      .send({ email: admin.email, password: PASSWORD })
      .expect(200);
    const secret = body.data.secret as string;
    const now = new Date();
    const res = await http()
      .post('/api/v1/admin/auth/enroll/confirm')
      .send({ email: admin.email, password: PASSWORD, code: totpCode(secret, totpStep(now)) })
      .expect(201);
    return { ...admin, secret, res, codes: res.body.data.recoveryCodes as string[] };
  }

  it('should send a new admin to enrolment, refuse a wrong first code and confirm the right one', async () => {
    const admin = await newAdmin();
    const blocked = await http()
      .post('/api/v1/admin/auth/login')
      .send({ email: admin.email, password: PASSWORD })
      .expect(401);
    expect(blocked.body.error).toMatchObject({
      code: 'AUTH-008',
      details: [{ field: 'code', message: 'validation.mfaEnrollment' }],
    });
    const { body } = await http()
      .post('/api/v1/admin/auth/enroll')
      .send({ email: admin.email, password: PASSWORD })
      .expect(200);
    expect(body.data.otpauthUri).toContain('otpauth://totp/');
    const stored = await raw.platformAdmin.findUniqueOrThrow({ where: { id: admin.id } });
    expect(stored.mfaSecret).toMatch(/^v1:/); // encrypted at rest (D-056)
    expect(stored.mfaSecret).not.toContain(body.data.secret);
    const wrong = await http()
      .post('/api/v1/admin/auth/enroll/confirm')
      .send({ email: admin.email, password: PASSWORD, code: '000000' })
      .expect(401);
    expect(wrong.body.error.code).toBe('AUTH-009');
    const ok = await http()
      .post('/api/v1/admin/auth/enroll/confirm')
      .send({
        email: admin.email,
        password: PASSWORD,
        code: totpCode(body.data.secret, totpStep(new Date())),
      })
      .expect(201);
    expect(ok.body.data.recoveryCodes).toHaveLength(10);
    expect(refreshCookie(ok)).toMatch(new RegExp(`^${ADMIN_REFRESH_COOKIE}=.+`));
    await http()
      .post('/api/v1/admin/auth/enroll')
      .send({ email: admin.email, password: PASSWORD })
      .expect(409);
    const codes = await raw.platformRecoveryCode.findMany({ where: { adminId: admin.id } });
    expect(codes).toHaveLength(10);
    expect(codes.map((c) => c.codeHash)).not.toContain(ok.body.data.recoveryCodes[0]);
  });

  it('should need the code (AUTH-008), refuse a wrong or replayed one (AUTH-009) and accept a recovery code once', async () => {
    const admin = await enrolled();
    const login = (extra: object) =>
      http()
        .post('/api/v1/admin/auth/login')
        .send({ email: admin.email, password: PASSWORD, ...extra });
    expect((await login({}).expect(401)).body.error.code).toBe('AUTH-008');
    expect((await login({ code: '123456' }).expect(401)).body.error.code).toBe('AUTH-009');
    // The confirmation used this step's code: the same code is refused, the next step's is accepted.
    const step = totpStep(new Date());
    expect((await login({ code: totpCode(admin.secret, step) }).expect(401)).body.error.code).toBe(
      'AUTH-009',
    );
    const signedIn = await login({ code: totpCode(admin.secret, step + 1) }).expect(200);
    expect(signedIn.body.data.admin).toMatchObject({ id: admin.id, email: admin.email });
    expect(signedIn.body.data.recoveryCodes).toBeUndefined();
    const recovery = admin.codes[0]?.toLowerCase().replace('-', '') ?? '';
    await login({ recoveryCode: recovery }).expect(200);
    expect((await login({ recoveryCode: recovery }).expect(401)).body.error.code).toBe('AUTH-009');
    const actions = (
      await raw.platformAuditLog.findMany({
        where: { adminId: admin.id },
        orderBy: { createdAt: 'asc' },
      })
    ).map((row) => row.action);
    expect(actions).toEqual(['MFA_ENROLLED', 'LOGIN', 'LOGIN', 'LOGIN_RECOVERY_CODE']);
  });

  it('should keep the realms apart: admin tokens only on admin routes, office tokens never there', async () => {
    const admin = await enrolled();
    const token = admin.res.body.data.accessToken as string;
    const me = await http()
      .get('/api/v1/admin/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(me.body.data).toEqual({ id: admin.id, fullName: 'Platform Admin', email: admin.email });
    await http().get('/api/v1/cases').set('Authorization', `Bearer ${token}`).expect(401);
    await http().get('/api/v1/admin/auth/me').expect(401);
    const forged = await http()
      .get('/api/v1/admin/auth/me')
      .set('Authorization', `Bearer ${token.slice(0, -2)}xx`)
      .expect(401);
    expect(forged.body.error.code).toBe('AUTH-003');
  });

  it('should rotate the session, end its family on reuse, and end it after 30 min idle', async () => {
    const admin = await enrolled();
    const first = refreshCookie(admin.res);
    await http().post('/api/v1/admin/auth/refresh').set('Cookie', first).expect(403); // no Origin / X-Requested-With
    const rotated = await http()
      .post('/api/v1/admin/auth/refresh')
      .set(csrf)
      .set('Cookie', first)
      .expect(200);
    const second = refreshCookie(rotated);
    const reused = await http()
      .post('/api/v1/admin/auth/refresh')
      .set(csrf)
      .set('Cookie', first)
      .expect(401);
    expect(reused.body.error.code).toBe('AUTH-005');
    expect(
      (await http().post('/api/v1/admin/auth/refresh').set(csrf).set('Cookie', second).expect(401))
        .body.error.code,
    ).toBe('AUTH-005');
    // A fresh sign-in, left idle for more than 30 minutes.
    const again = await http()
      .post('/api/v1/admin/auth/login')
      .send({ email: admin.email, password: PASSWORD, recoveryCode: admin.codes[1] })
      .expect(200);
    await raw.platformSession.updateMany({
      where: { adminId: admin.id, revokedAt: null },
      data: { idleUntil: new Date(Date.now() - 1000) },
    });
    const idle = await http()
      .post('/api/v1/admin/auth/refresh')
      .set(csrf)
      .set('Cookie', refreshCookie(again))
      .expect(401);
    expect(idle.body.error.code).toBe('AUTH-004');
    // The access token of an ended session stops at once.
    const ended = await http()
      .get('/api/v1/admin/auth/me')
      .set('Authorization', `Bearer ${again.body.data.accessToken as string}`)
      .expect(401);
    expect(ended.body.error.code).toBe('AUTH-004');
  });

  it('should sign out (idempotent, audited) and lock an address after five wrong passwords', async () => {
    const admin = await enrolled();
    await http()
      .post('/api/v1/admin/auth/logout')
      .set(csrf)
      .set('Cookie', refreshCookie(admin.res))
      .expect(204);
    await http()
      .post('/api/v1/admin/auth/logout')
      .set(csrf)
      .set('Cookie', refreshCookie(admin.res))
      .expect(204);
    await http()
      .get('/api/v1/admin/auth/me')
      .set('Authorization', `Bearer ${admin.res.body.data.accessToken as string}`)
      .expect(401);
    expect(
      await raw.platformAuditLog.count({ where: { adminId: admin.id, action: 'LOGOUT' } }),
    ).toBe(1);
    for (let i = 0; i < 5; i += 1) {
      const wrong = await http()
        .post('/api/v1/admin/auth/login')
        .send({ email: admin.email, password: 'Wrong-Password-1' })
        .expect(401);
      expect(wrong.body.error.code).toBe('AUTH-001');
    }
    const locked = await http()
      .post('/api/v1/admin/auth/login')
      .send({ email: admin.email, password: PASSWORD })
      .expect(423);
    expect(locked.body.error.code).toBe('AUTH-007');
  });
});
