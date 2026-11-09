import { randomUUID } from 'node:crypto';

import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import request from 'supertest';

import { AppModule } from '../../app/app.module';
import { configureApp } from '../../app/configure-app';
import { integrationEnv } from '../../config/env.fixture';
import { PrismaService } from '../../database/prisma.service';
import type { PrismaClient } from '../../generated/prisma/client';
import { PasswordHasher } from '../auth/password-hasher';
import { totpCode, totpStep } from '../platform-auth/totp';
import { liveSubscription } from '../subscriptions/subscription.test-helper';

const PASSWORD = 'Admin-Correct-Horse-9';
const ORIGIN = 'http://localhost:4201';

/** Platform admin office overview, suspension and reactivation (MVP-102, D-145) on real PostgreSQL. */
describe('platform admin offices (HTTP + PostgreSQL)', () => {
  let app: NestExpressApplication;
  let raw: PrismaClient;
  const savedEnv = { ...process.env };
  const http = () => request(app.getHttpServer());
  const officeIds: string[] = [];
  const emails: string[] = [];
  let adminId = '';
  let auth = { Authorization: '' };
  const tag = `po-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    Object.assign(process.env, integrationEnv(), {
      ADMIN_JWT_SECRET: 'integration-only-admin-secret-0123456789abcdef',
      ADMIN_IP_ALLOWLIST: '127.0.0.1, ::1',
      CORS_ORIGINS: ORIGIN,
      ADMIN_ORIGINS: ORIGIN,
    });
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = module.createNestApplication<NestExpressApplication>({ bufferLogs: true });
    configureApp(app);
    await app.init();
    // unscoped: platform fixtures.
    raw = app.get(PrismaService).unscoped();

    const email = `admin-${randomUUID()}@example.test`;
    emails.push(email);
    const admin = await raw.platformAdmin.create({
      data: {
        email,
        fullName: 'Platform Admin',
        passwordHash: await new PasswordHasher().hash(PASSWORD),
      },
    });
    adminId = admin.id;
    const enroll = await http()
      .post('/api/v1/admin/auth/enroll')
      .send({ email, password: PASSWORD })
      .expect(200);
    const confirmed = await http()
      .post('/api/v1/admin/auth/enroll/confirm')
      .send({
        email,
        password: PASSWORD,
        code: totpCode(enroll.body.data.secret as string, totpStep(new Date())),
      })
      .expect(201);
    auth = { Authorization: `Bearer ${confirmed.body.data.accessToken as string}` };
  });

  afterAll(async () => {
    if (!raw) return;
    // Also sweeps offices a crashed earlier run left behind (names start with po-).
    const stale = await raw.office.findMany({
      where: { name: { startsWith: 'po-' } },
      select: { id: true },
    });
    officeIds.push(...stale.map((o) => o.id));
    await raw.aiUsage.deleteMany({ where: { officeId: { in: officeIds } } });
    await raw.platformAuditLog.deleteMany({
      where: { OR: [{ adminId }, { targetOfficeId: { in: officeIds } }] },
    });
    await raw.platformSession.deleteMany({ where: { adminId } });
    await raw.platformRecoveryCode.deleteMany({ where: { adminId } });
    await raw.platformAdmin.deleteMany({ where: { id: adminId } });
    await raw.loginAttempt.deleteMany({ where: { email: { in: emails } } });
    await raw.refreshToken.deleteMany({ where: { officeId: { in: officeIds } } });
    await raw.documentVersion.deleteMany({ where: { officeId: { in: officeIds } } });
    await raw.auditLog.deleteMany({ where: { officeId: { in: officeIds } } });
    await raw.user.deleteMany({ where: { officeId: { in: officeIds } } });
    await raw.subscription.deleteMany({ where: { officeId: { in: officeIds } } });
    await raw.officeSettings.deleteMany({ where: { officeId: { in: officeIds } } });
    await raw.office.deleteMany({ where: { id: { in: officeIds } } });
    await app?.close();
    process.env = savedEnv;
  });

  async function seedOffice(name: string, jurisdiction: 'PALESTINE' | 'JORDAN', users: number) {
    const office = await raw.office.create({
      data: { name: `${tag} ${name}`, jurisdiction, subscriptions: liveSubscription() },
    });
    officeIds.push(office.id);
    const hash = await new PasswordHasher().hash(PASSWORD);
    const created = [];
    for (let i = 0; i < users; i++) {
      const email = `po-${randomUUID()}@example.test`;
      emails.push(email);
      created.push(
        await raw.user.create({
          data: {
            officeId: office.id,
            fullName: 'Office User',
            email,
            passwordHash: hash,
            role: 'OFFICE_MANAGER',
            lastLoginAt: i === 0 ? new Date('2026-01-02T03:04:05Z') : null,
          },
        }),
      );
    }
    return { office, users: created };
  }

  const officeLogin = (email: string) =>
    http().post('/api/v1/auth/login').send({ email, password: PASSWORD, rememberMe: false });

  it('should list offices with filters and usage, newest first', async () => {
    const a = await seedOffice('Alpha', 'PALESTINE', 2);
    const b = await seedOffice('Beta_%', 'JORDAN', 1);
    await raw.aiUsage.createMany({
      data: [
        { succeeded: true },
        { succeeded: true, cached: true },
        { succeeded: false },
        { succeeded: true, partial: true },
      ].map((flags) => ({
        officeId: a.office.id,
        feature: 'test',
        provider: 'fake',
        model: 'fake',
        inputTokens: 1,
        outputTokens: 1,
        costUsd: '0',
        durationMs: 1,
        ...flags,
      })),
    });
    const res = await http()
      .get('/api/v1/admin/offices')
      .query({ search: tag, limit: 10 })
      .set(auth)
      .expect(200);
    expect(res.body.meta.pagination.total).toBe(2);
    const [first, second] = res.body.data;
    expect(first.id).toBe(b.office.id); // newest first
    expect(second).toMatchObject({
      id: a.office.id,
      status: 'ACTIVE',
      plan: { code: 'GLOBAL_ENTERPRISE' },
      subscriptionStatus: 'ACTIVE',
      usage: { activeUsers: 2, liveFiles: 0, storageMb: 0, aiThisMonth: 1 },
      lastActivityAt: '2026-01-02T03:04:05.000Z',
    });

    const only = (query: object) =>
      http()
        .get('/api/v1/admin/offices')
        .query({ search: tag, ...query })
        .set(auth)
        .expect(200);
    expect(
      (await only({ jurisdiction: 'JORDAN' })).body.data.map((o: { id: string }) => o.id),
    ).toEqual([b.office.id]);
    expect((await only({ search: `${tag} Beta_%` })).body.data).toHaveLength(1); // wildcards are literal
    expect((await only({ search: `${tag} Beta__` })).body.data).toHaveLength(0);
    expect((await only({ plan: 'GLOBAL_ENTERPRISE' })).body.data).toHaveLength(2);
    expect((await only({ plan: 'NOPE' })).body.data).toHaveLength(0);
    expect((await only({ status: 'SUSPENDED' })).body.data).toHaveLength(0);
    const day = new Date().toISOString().slice(0, 10);
    expect((await only({ createdFrom: day, createdTo: day })).body.data).toHaveLength(2);
    expect((await only({ createdTo: '2020-01-01' })).body.data).toHaveLength(0);
    expect((await only({ limit: 1, page: 2 })).body.data.map((o: { id: string }) => o.id)).toEqual([
      a.office.id,
    ]);
  });

  it('should answer 404 RES-001 for an unknown or malformed office id and refuse office tokens', async () => {
    for (const id of [randomUUID(), 'not-a-uuid']) {
      const res = await http().get(`/api/v1/admin/offices/${id}`).set(auth).expect(404);
      expect(res.body.error.code).toBe('RES-001');
    }
    await http()
      .post(`/api/v1/admin/offices/${randomUUID()}/suspend`)
      .set(auth)
      .send({ reason: 'abuse' })
      .expect(404);
    const { users } = await seedOffice('Realm', 'PALESTINE', 1);
    const office = await officeLogin(users[0]?.email ?? '').expect(200);
    const token = office.body.data.accessToken as string;
    await http().get('/api/v1/admin/offices').set('Authorization', `Bearer ${token}`).expect(401);
    await http().get('/api/v1/admin/offices').expect(401);
  });

  it('should suspend (sessions ended, sign-in refused), stay a no-op the second time and reactivate', async () => {
    const { office, users } = await seedOffice('Suspend', 'PALESTINE', 1);
    const email = users[0]?.email ?? '';
    const session = await officeLogin(email).expect(200);
    const bearer = { Authorization: `Bearer ${session.body.data.accessToken as string}` };
    await http().get('/api/v1/offices/me/subscription').set(bearer).expect(200);

    await http()
      .post(`/api/v1/admin/offices/${office.id}/suspend`)
      .set(auth)
      .send({ reason: ' ' })
      .expect(400);
    const done = await http()
      .post(`/api/v1/admin/offices/${office.id}/suspend`)
      .set(auth)
      .send({ reason: 'Unpaid invoice' })
      .expect(200);
    expect(done.body.data).toMatchObject({
      status: 'SUSPENDED',
      suspension: { reason: 'Unpaid invoice' },
    });
    await expect(
      raw.refreshToken.count({ where: { officeId: office.id, revokedAt: null } }),
    ).resolves.toBe(0);
    expect((await officeLogin(email).expect(403)).body.error.code).toBe('AUTH-006');
    expect(
      (await http().get('/api/v1/offices/me/subscription').set(bearer).expect(403)).body.error.code,
    ).toBe('AUTH-006');

    await http()
      .post(`/api/v1/admin/offices/${office.id}/suspend`)
      .set(auth)
      .send({ reason: 'again' })
      .expect(200);
    await expect(
      raw.platformAuditLog.count({
        where: { targetOfficeId: office.id, action: 'OFFICE_SUSPENDED' },
      }),
    ).resolves.toBe(1);

    const back = await http()
      .post(`/api/v1/admin/offices/${office.id}/reactivate`)
      .set(auth)
      .send({})
      .expect(200);
    expect(back.body.data).toMatchObject({ status: 'ACTIVE', suspension: null });
    await http()
      .post(`/api/v1/admin/offices/${office.id}/reactivate`)
      .set(auth)
      .send({})
      .expect(200);
    await officeLogin(email).expect(200);
    const rows = await raw.platformAuditLog.findMany({
      where: { targetOfficeId: office.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows.map((r) => r.action)).toEqual(['OFFICE_SUSPENDED', 'OFFICE_REACTIVATED']);
    expect(rows[0]).toMatchObject({ adminId, entityType: 'Office', entityId: office.id });
    expect(rows[0]?.newValues).toEqual({ reason: 'Unpaid invoice' });
  });
});
