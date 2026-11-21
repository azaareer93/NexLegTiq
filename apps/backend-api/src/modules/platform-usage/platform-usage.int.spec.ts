import { randomUUID } from 'node:crypto';

import { JwtService } from '@nestjs/jwt';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import request from 'supertest';

import { AppModule } from '../../app/app.module';
import { configureApp } from '../../app/configure-app';
import { QUEUE_NAMES } from '../../common/queue/queues';
import { integrationEnv } from '../../config/env.fixture';
import { PrismaService } from '../../database/prisma.service';
import type { PrismaClient } from '../../generated/prisma/client';
import { bearerFor } from '../auth/auth.test-helper';
import { PasswordHasher } from '../auth/password-hasher';
import { totpCode, totpStep } from '../platform-auth/totp';
import { liveSubscription } from '../subscriptions/subscription.test-helper';

const PASSWORD = 'Admin-Correct-Horse-9';
const ORIGIN = 'http://localhost:4201';

/** Platform usage, queues and the platform audit (MVP-103, D-183) on real PostgreSQL and Redis. */
describe('platform usage (HTTP + PostgreSQL)', () => {
  let app: NestExpressApplication;
  let raw: PrismaClient;
  const savedEnv = { ...process.env };
  const http = () => request(app.getHttpServer());
  const officeIds: string[] = [];
  let adminId = '';
  let email = '';
  let auth = { Authorization: '' };

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
    email = `admin-${randomUUID()}@example.test`;
    const admin = await raw.platformAdmin.create({
      data: {
        email,
        fullName: 'Usage Admin',
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
    const office = await raw.office.create({
      data: {
        name: `pu-${randomUUID().slice(0, 8)}`,
        settings: { create: {} },
        subscriptions: liveSubscription(),
      },
    });
    officeIds.push(office.id);
    await raw.aiUsage.createMany({
      data: ['0.250000', '0.125000'].map((costUsd) => ({
        officeId: office.id,
        feature: 'test',
        provider: 'fake',
        model: 'pu-model',
        inputTokens: 1,
        outputTokens: 1,
        costUsd,
        durationMs: 1,
        succeeded: true,
      })),
    });
  });

  afterAll(async () => {
    if (!raw) return;
    await raw.aiUsage.deleteMany({ where: { officeId: { in: officeIds } } });
    await raw.platformAuditLog.deleteMany({ where: { adminId } });
    await raw.platformSession.deleteMany({ where: { adminId } });
    await raw.platformRecoveryCode.deleteMany({ where: { adminId } });
    await raw.platformAdmin.deleteMany({ where: { id: adminId } });
    await raw.loginAttempt.deleteMany({ where: { email } });
    await raw.subscription.deleteMany({ where: { officeId: { in: officeIds } } });
    await raw.officeSettings.deleteMany({ where: { officeId: { in: officeIds } } });
    await raw.office.deleteMany({ where: { id: { in: officeIds } } });
    await app?.close();
    process.env = savedEnv;
  });

  const get = (path: string) => http().get(`/api/v1/admin/${path}`).set(auth).set('Origin', ORIGIN);

  it('should sum AI cost per office and model and per day, and count new offices', async () => {
    const res = await get('usage?days=30');
    expect(res.status).toBe(200);
    const mine = res.body.data.aiCostByOffice.find(
      (r: { officeId: string }) => r.officeId === officeIds[0],
    );
    expect(mine).toMatchObject({ model: 'pu-model', operations: 2 });
    expect(Number(mine.costUsd)).toBeCloseTo(0.375, 6);
    const today = new Date().toISOString().slice(0, 10);
    expect(res.body.data.aiCostByDay.map((d: { date: string }) => d.date)).toContain(today);
    expect(res.body.data.signups.offices).toBeGreaterThanOrEqual(1);
    expect((await get('usage?days=3')).status).toBe(400);
  });

  it('should count jobs per queue', async () => {
    const res = await get('queues');
    expect(res.status).toBe(200);
    expect(res.body.data.map((q: { name: string }) => q.name)).toEqual([...QUEUE_NAMES]);
    expect(typeof res.body.data[0].failed).toBe('number');
  });

  it("should list and export the platform audit, filtered by admin, and refuse an office user's token", async () => {
    const page = await get(`audit?adminId=${adminId}`);
    expect(page.status).toBe(200);
    expect(page.body.data.items.length).toBeGreaterThan(0);
    expect(page.body.data.items[0].admin).toEqual({ id: adminId, name: 'Usage Admin' });
    const csv = await get(`audit/export?adminId=${adminId}`);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain('Usage Admin');
    const anonymous = await http().get('/api/v1/admin/usage').set('Origin', ORIGIN);
    expect([401, 403]).toContain(anonymous.status);
  });

  it('should count the funnel, onboarding steps and D7/D30 retention of recent signups (D-215)', async () => {
    type Analytics = {
      funnel: { event: string; offices: number }[];
      onboardingSteps: { step: string; offices: number }[];
      retention: {
        d7: { offices: number; retained: number };
        d30: { offices: number; retained: number };
      };
    };
    const read = async () => {
      const res = await get('analytics?days=60');
      expect(res.status).toBe(200);
      return res.body.data as Analytics;
    };
    const funnel = (a: Analytics, event: string) =>
      a.funnel.find((f) => f.event === event)?.offices;
    const step = (a: Analytics, s: string) => a.onboardingSteps.find((f) => f.step === s)?.offices;
    // Other suites share the database: compare before and after this office's events.
    const before = await read();
    const office = await raw.office.create({
      data: { name: `pa-${randomUUID().slice(0, 8)}`, settings: { create: {} } },
    });
    officeIds.push(office.id);
    const ago = (days: number) => new Date(Date.now() - days * 86_400_000);
    await raw.productEvent.createMany({
      data: [
        { officeId: office.id, event: 'SIGNUP_COMPLETED', createdAt: ago(40) },
        {
          officeId: office.id,
          event: 'ONBOARDING_STEP_COMPLETED',
          props: { step: 'CASE' },
          createdAt: ago(40),
        },
        {
          officeId: office.id,
          event: 'FIRST_CASE_CREATED',
          props: { secondsSinceSignup: 60 },
          createdAt: ago(40),
        },
        // Active on day 8 (D7), not on days 30–36 (D30).
        { officeId: office.id, event: 'APP_ACTIVE', createdAt: ago(32) },
        { officeId: office.id, event: 'APP_ACTIVE', createdAt: ago(1) },
      ],
    });
    // Signed up late on a UTC day, active early on UTC day 7: under 7×24 h, still D7 (one activity row per day).
    const late = await raw.office.create({
      data: { name: `pa-${randomUUID().slice(0, 8)}`, settings: { create: {} } },
    });
    officeIds.push(late.id);
    const day = (n: number, hour: number) => {
      const d = new Date(Date.now() - n * 86_400_000);
      d.setUTCHours(hour, 0, 0, 0);
      return d;
    };
    await raw.productEvent.createMany({
      data: [
        { officeId: late.id, event: 'SIGNUP_COMPLETED', createdAt: day(20, 23) },
        { officeId: late.id, event: 'APP_ACTIVE', createdAt: day(13, 1) },
      ],
    });
    const after = await read();
    expect(funnel(after, 'SIGNUP_COMPLETED')).toBe((funnel(before, 'SIGNUP_COMPLETED') ?? 0) + 2);
    expect(funnel(after, 'FIRST_CASE_CREATED')).toBe(
      (funnel(before, 'FIRST_CASE_CREATED') ?? 0) + 1,
    );
    expect(funnel(after, 'INVITE_SENT')).toBe(funnel(before, 'INVITE_SENT'));
    expect(step(after, 'CASE')).toBe((step(before, 'CASE') ?? 0) + 1);
    expect(after.retention.d7).toEqual({
      offices: before.retention.d7.offices + 2,
      retained: before.retention.d7.retained + 2,
    });
    expect(after.retention.d30).toEqual({
      offices: before.retention.d30.offices + 1,
      retained: before.retention.d30.retained,
    });
    expect((await get('analytics?days=400')).status).toBe(400);
    const anonymous = await http().get('/api/v1/admin/analytics').set('Origin', ORIGIN);
    expect([401, 403]).toContain(anonymous.status);
    // An office user's token never reads across offices.
    const officeAuth = bearerFor(app.get(JwtService), {
      userId: randomUUID(),
      officeId: officeIds[0] ?? randomUUID(),
      role: 'OFFICE_MANAGER',
    });
    const refused = await http()
      .get('/api/v1/admin/analytics')
      .set(officeAuth)
      .set('Origin', ORIGIN);
    expect([401, 403]).toContain(refused.status);
  });
});
