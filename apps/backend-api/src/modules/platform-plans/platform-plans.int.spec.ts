import { randomUUID } from 'node:crypto';

import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { OfficeId } from '@nexlegtiq/shared-types';
import request from 'supertest';

import { AppModule } from '../../app/app.module';
import { configureApp } from '../../app/configure-app';
import { integrationEnv } from '../../config/env.fixture';
import { PrismaService } from '../../database/prisma.service';
import type { PrismaClient } from '../../generated/prisma/client';
import { PasswordHasher } from '../auth/password-hasher';
import { totpCode, totpStep } from '../platform-auth/totp';
import { EntitlementsService } from '../subscriptions/entitlements.service';

const PASSWORD = 'Admin-Correct-Horse-9';
const ORIGIN = 'http://localhost:4201';

/** Plans CRUD and subscription actions (MVP-151, D-173) on real PostgreSQL. */
describe('platform admin plans and subscriptions (HTTP + PostgreSQL)', () => {
  let app: NestExpressApplication;
  let raw: PrismaClient;
  let entitlements: EntitlementsService;
  const savedEnv = { ...process.env };
  const http = () => request(app.getHttpServer());
  const officeIds: string[] = [];
  const planCodes: string[] = [];
  let email = '';
  let adminId = '';
  let auth = { Authorization: '' };
  const tag = randomUUID().slice(0, 6).toUpperCase().replace(/-/g, '');
  const code = (name: string) => {
    const value = `T${tag}_${name}${planCodes.length}`;
    planCodes.push(value);
    return value;
  };

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
    entitlements = app.get(EntitlementsService);

    email = `admin-${randomUUID()}@example.test`;
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
    await raw.platformAuditLog.deleteMany({ where: { adminId } });
    await raw.platformSession.deleteMany({ where: { adminId } });
    await raw.platformRecoveryCode.deleteMany({ where: { adminId } });
    await raw.platformAdmin.deleteMany({ where: { id: adminId } });
    await raw.loginAttempt.deleteMany({ where: { email } });
    await raw.subscription.deleteMany({ where: { officeId: { in: officeIds } } });
    await raw.office.deleteMany({ where: { id: { in: officeIds } } });
    await raw.plan.deleteMany({ where: { code: { in: planCodes } } });
    await app?.close();
    process.env = savedEnv;
  });

  const body = (over: Record<string, unknown> = {}) => ({
    code: code('PRO'),
    name: 'Pro',
    market: 'PALESTINE',
    priceMonthly: '25.50',
    currency: 'USD',
    maxUsers: 5,
    aiQuotaMonthly: 50,
    storageQuotaMb: 2048,
    features: { googleVisionOcr: true },
    ...over,
  });

  async function officeOn(planId: string, status: 'TRIALING' | 'ACTIVE' = 'TRIALING') {
    const office = await raw.office.create({
      data: {
        name: `pp-${tag}`,
        jurisdiction: 'PALESTINE',
        subscriptions: {
          create: {
            planId,
            status,
            currentPeriodStart: new Date(),
            trialEndsAt: status === 'TRIALING' ? new Date(Date.now() + 86_400_000) : null,
          },
        },
      },
    });
    officeIds.push(office.id);
    return office.id;
  }

  it('should refuse plans without an admin session', async () => {
    await http().get('/api/v1/admin/plans').expect(401);
  });

  it('should create, list, update and delete a plan, auditing each step', async () => {
    const created = await http().post('/api/v1/admin/plans').set(auth).send(body()).expect(201);
    const plan = created.body.data;
    expect(plan).toMatchObject({
      priceMonthly: '25.50',
      ocrPagesMonthly: 0,
      isActive: true,
      subscriptionCount: 0,
    });

    await http()
      .post('/api/v1/admin/plans')
      .set(auth)
      .send(body({ code: plan.code }))
      .expect(409);
    const invalid = await http()
      .post('/api/v1/admin/plans')
      .set(auth)
      .send(body({ code: 'lower', priceMonthly: '1.234' }))
      .expect(400);
    expect(invalid.body.error.code).toBe('VAL-001');

    const list = await http().get('/api/v1/admin/plans').set(auth).expect(200);
    expect(list.body.data.map((p: { code: string }) => p.code)).toContain(plan.code);

    const updated = await http()
      .patch(`/api/v1/admin/plans/${plan.id as string}`)
      .set(auth)
      .send({ name: 'Pro+', isActive: false })
      .expect(200);
    expect(updated.body.data).toMatchObject({ name: 'Pro+', isActive: false, code: plan.code });

    await http()
      .delete(`/api/v1/admin/plans/${plan.id as string}`)
      .set(auth)
      .expect(204);
    await http()
      .delete(`/api/v1/admin/plans/${plan.id as string}`)
      .set(auth)
      .expect(404);
    const audit = await raw.platformAuditLog.findMany({
      where: { adminId, entityId: plan.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(audit.map((a) => a.action)).toEqual(['PLAN_CREATED', 'PLAN_UPDATED', 'PLAN_DELETED']);
  });

  it('should not delete a plan in use (BIZ-022)', async () => {
    const plan = (await http().post('/api/v1/admin/plans').set(auth).send(body()).expect(201)).body
      .data;
    await officeOn(plan.id as string);
    const res = await http()
      .delete(`/api/v1/admin/plans/${plan.id as string}`)
      .set(auth)
      .expect(422);
    expect(res.body.error.code).toBe('BIZ-022');
  });

  it('should show a plan change and a plan edit in the office entitlements at once', async () => {
    const free = (
      await http()
        .post('/api/v1/admin/plans')
        .set(auth)
        .send(body({ code: code('FREE'), maxUsers: 2, priceMonthly: '0' }))
        .expect(201)
    ).body.data;
    const pro = (await http().post('/api/v1/admin/plans').set(auth).send(body()).expect(201)).body
      .data;
    const officeId = (await officeOn(free.id as string)) as OfficeId;
    expect((await entitlements.forOffice(officeId)).maxUsers).toBe(2);

    const changed = await http()
      .post(`/api/v1/admin/offices/${officeId}/subscription`)
      .set(auth)
      .send({ action: 'CHANGE_PLAN', planId: pro.id, reason: 'paid in cash' })
      .expect(200);
    expect(changed.body.data.plan.code).toBe(pro.code);
    expect((await entitlements.forOffice(officeId)).maxUsers).toBe(5);

    await http()
      .patch(`/api/v1/admin/plans/${pro.id as string}`)
      .set(auth)
      .send({ maxUsers: 9 })
      .expect(200);
    expect((await entitlements.forOffice(officeId)).maxUsers).toBe(9);

    const audit = await raw.platformAuditLog.findFirstOrThrow({
      where: { adminId, targetOfficeId: officeId, action: 'SUBSCRIPTION_PLAN_CHANGED' },
    });
    expect(audit.newValues).toMatchObject({ planId: pro.id, reason: 'paid in cash' });
  });

  it('should extend a trial, turn it paid, and refuse a trial on the paid subscription', async () => {
    const plan = (await http().post('/api/v1/admin/plans').set(auth).send(body()).expect(201)).body
      .data;
    const officeId = await officeOn(plan.id as string);
    const url = `/api/v1/admin/offices/${officeId}/subscription`;

    await http().post(url).set(auth).send({ action: 'SET_TRIAL', until: '2099-06-30' }).expect(200);
    const trial = await raw.subscription.findFirstOrThrow({ where: { officeId } });
    expect(trial.status).toBe('TRIALING');
    // The last day runs to midnight in Hebron (UTC+3 in summer).
    expect(trial.trialEndsAt?.toISOString()).toBe('2099-06-30T21:00:00.000Z');

    const paid = await http()
      .post(url)
      .set(auth)
      .send({ action: 'EXTEND_PERIOD', until: '2099-12-31' })
      .expect(200);
    expect(paid.body.data.subscriptionStatus).toBe('ACTIVE');
    expect((await entitlements.forOffice(officeId as OfficeId)).status).toBe('ACTIVE');

    const refused = await http()
      .post(url)
      .set(auth)
      .send({ action: 'SET_TRIAL', until: '2099-12-31' })
      .expect(422);
    expect(refused.body.error.code).toBe('BIZ-023');
    await http()
      .post(url)
      .set(auth)
      .send({ action: 'EXTEND_PERIOD', until: '2020-01-01' })
      .expect(400);
    expect(await raw.subscription.count({ where: { officeId } })).toBe(1);
  });

  it('should answer 404 for an unknown office or a malformed id', async () => {
    const action = { action: 'SET_TRIAL', until: '2099-12-31' };
    await http()
      .post(`/api/v1/admin/offices/${randomUUID()}/subscription`)
      .set(auth)
      .send(action)
      .expect(404);
    await http().post('/api/v1/admin/offices/nope/subscription').set(auth).send(action).expect(404);
  });
});
