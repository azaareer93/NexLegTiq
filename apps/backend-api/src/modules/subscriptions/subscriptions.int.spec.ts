import { randomUUID } from 'node:crypto';

import { JwtService } from '@nestjs/jwt';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { OfficeSubscription } from '@nexlegtiq/shared-contracts';
import type { OfficeId, Role } from '@nexlegtiq/shared-types';
import request from 'supertest';

import { EntitlementsService } from './entitlements.service';
import { PLANS, seedPlans } from '../../../prisma/seed';
import { AppModule } from '../../app/app.module';
import { configureApp } from '../../app/configure-app';
import { TenantRunner } from '../../common/tenancy/tenant-runner';
import { integrationEnv } from '../../config/env.fixture';
import { PrismaService } from '../../database/prisma.service';
import { TENANT_MODELS } from '../../database/tenant-models';
import type { PrismaClient } from '../../generated/prisma/client';
import { bearerFor } from '../auth/auth.test-helper';

type Delegate = { deleteMany(args: unknown): Promise<unknown> };
interface SeededUser {
  readonly userId: string;
  readonly officeId: string;
  readonly role: Role;
}
type ErrorBody = { error: { code: string } };

const DAY = 86_400_000;
const FREE = PLANS.find((plan) => plan.code === 'PS_FREE');

/** MVP-51 through HTTP on real PostgreSQL: the subscription view, read-only mode and the quota checks (D-122). */
describe('subscriptions and entitlements (HTTP + PostgreSQL)', () => {
  let app: NestExpressApplication;
  let raw: PrismaClient;
  let jwt: JwtService;
  let entitlements: EntitlementsService;
  const officeIds: string[] = [];
  const savedEnv = { ...process.env };

  const http = () => request(app.getHttpServer());
  const as = (user: SeededUser) => bearerFor(jwt, user);
  const createClient = (user: SeededUser) =>
    http()
      .post('/api/v1/clients')
      .set(as(user))
      .send({ clientType: 'INDIVIDUAL', displayName: 'Client' });

  async function seedUser(officeId: string, role: Role = 'OFFICE_MANAGER'): Promise<SeededUser> {
    const user = await raw.user.create({
      data: {
        officeId,
        fullName: `${role} ${randomUUID().slice(0, 4)}`,
        email: `subscriptions-${randomUUID()}@example.test`,
        passwordHash: '!',
        role,
      },
    });
    return { userId: user.id, officeId, role };
  }

  /** An office on the Palestine freemium plan whose trial ends `trialEndsInDays` from now; returns its manager. */
  async function seedOffice(trialEndsInDays: number): Promise<SeededUser> {
    const plan = await raw.plan.findUniqueOrThrow({ where: { code: 'PS_FREE' } });
    const trialEndsAt = new Date(Date.now() + trialEndsInDays * DAY);
    const office = await raw.office.create({
      data: {
        name: 'Subscriptions office',
        settings: { create: {} },
        subscriptions: {
          create: {
            planId: plan.id,
            status: 'TRIALING',
            currentPeriodStart: new Date(Date.now() - 30 * DAY),
            currentPeriodEnd: trialEndsAt,
            trialEndsAt,
          },
        },
      },
    });
    officeIds.push(office.id);
    return seedUser(office.id);
  }

  const inOffice = <T>(user: SeededUser, work: () => Promise<T>) =>
    app.get(TenantRunner).run({ officeId: user.officeId as OfficeId }, work);

  beforeAll(async () => {
    Object.assign(process.env, integrationEnv(), { EMAIL_VERIFICATION_ENFORCED: 'false' });
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = module.createNestApplication<NestExpressApplication>({ bufferLogs: true });
    configureApp(app);
    await app.init();
    // unscoped: test fixtures.
    raw = app.get(PrismaService).unscoped();
    jwt = app.get(JwtService);
    entitlements = app.get(EntitlementsService);
    await seedPlans(raw);
  }, 60_000);

  afterAll(async () => {
    if (raw) {
      const where = { officeId: { in: officeIds } };
      for (const model of [...TENANT_MODELS].filter((name) => name !== 'User').reverse()) {
        const name = model.charAt(0).toLowerCase() + model.slice(1);
        await (raw as unknown as Record<string, Delegate>)[name]?.deleteMany({ where });
      }
      await raw.user.deleteMany({ where });
      await raw.office.deleteMany({ where: { id: { in: officeIds } } });
    }
    await app?.close();
    process.env = savedEnv;
  });

  const subscriptionOf = async (user: SeededUser) =>
    (
      (await http().get('/api/v1/offices/me/subscription').set(as(user)).expect(200)).body as {
        data: OfficeSubscription;
      }
    ).data;

  it('should refuse the subscription view without a token (401 AUTH-003)', async () => {
    const res = await http().get('/api/v1/offices/me/subscription').expect(401);
    expect((res.body as ErrorBody).error.code).toBe('AUTH-003');
  });

  it('should show the plan, limits, flags and usage to a manager, the status only to other roles', async () => {
    const manager = await seedOffice(10);
    const trainee = await seedUser(manager.officeId, 'TRAINEE');
    expect(await subscriptionOf(trainee)).toMatchObject({
      plan: { code: 'PS_FREE' },
      status: 'TRIALING',
      readOnly: false,
      limits: null,
      usage: null,
    });
    expect(await subscriptionOf(manager)).toMatchObject({
      plan: { code: 'PS_FREE', name: FREE?.name },
      status: 'TRIALING',
      readOnly: false,
      limits: {
        users: FREE?.maxUsers,
        storageMb: FREE?.storageQuotaMb,
        aiMonthly: FREE?.aiQuotaMonthly,
      },
      features: { ai: true, clientPortal: true, googleVisionOcr: false },
      usage: { users: 2, storageMb: 0, aiThisMonth: 0 },
    });
  });

  it("should show each office its own subscription and keep one office's end from another", async () => {
    const ended = await seedOffice(-1);
    const running = await seedOffice(10);
    await seedUser(running.officeId, 'LAWYER');
    expect(await subscriptionOf(ended)).toMatchObject({ readOnly: true, usage: { users: 1 } });
    expect(await subscriptionOf(running)).toMatchObject({ readOnly: false, usage: { users: 2 } });
    await createClient(running).expect(201);
    await createClient(ended).expect(403);
  });

  it('should make an office whose trial ended read-only: reads pass, writes get 403 AUTH-104', async () => {
    const manager = await seedOffice(-1);
    const sub = await http().get('/api/v1/offices/me/subscription').set(as(manager)).expect(200);
    expect((sub.body as { data: OfficeSubscription }).data).toMatchObject({
      status: 'EXPIRED',
      readOnly: true,
    });
    await http().get('/api/v1/clients').set(as(manager)).expect(200);
    const write = await createClient(manager).expect(403);
    expect((write.body as ErrorBody).error.code).toBe('AUTH-104');
    expect(await raw.client.count({ where: { officeId: manager.officeId } })).toBe(0);
    const clientId = (
      await raw.client.create({
        data: { officeId: manager.officeId, clientType: 'INDIVIDUAL', displayName: 'Kept' },
      })
    ).id;
    for (const call of [
      () => http().patch(`/api/v1/clients/${clientId}`).send({ displayName: 'Changed' }),
      () => http().delete(`/api/v1/clients/${clientId}`),
    ]) {
      const refused = await call().set(as(manager)).expect(403);
      expect((refused.body as ErrorBody).error.code).toBe('AUTH-104');
    }
    expect(await raw.client.findUniqueOrThrow({ where: { id: clientId } })).toMatchObject({
      displayName: 'Kept',
      deletedAt: null,
    });
    // The caller's own password stays changeable: this fails on the wrong current password, not on AUTH-104.
    const password = await http()
      .post('/api/v1/users/me/password')
      .set(as(manager))
      .send({ currentPassword: 'wrong-Password1', newPassword: 'Another-Password2' })
      .expect(400);
    expect((password.body as ErrorBody).error.code).toBe('VAL-001');
  });

  it('should apply a renewed subscription once the cached entitlements are dropped', async () => {
    const manager = await seedOffice(-1);
    await createClient(manager).expect(403);
    await raw.subscription.updateMany({
      where: { officeId: manager.officeId },
      data: { status: 'ACTIVE', currentPeriodEnd: new Date(Date.now() + 30 * DAY) },
    });
    // Still the cached (ended) entitlements until they are dropped or expire.
    await createClient(manager).expect(403);
    entitlements.invalidate(manager.officeId as OfficeId);
    await createClient(manager).expect(201);
  });

  it('should refuse a sixth seat on a five-user plan with BIZ-008, counting pending invitations', async () => {
    const manager = await seedOffice(10);
    for (let i = 0; i < 3; i += 1) await seedUser(manager.officeId, 'LAWYER');
    await inOffice(manager, () => entitlements.assertUserSlot());
    await raw.officeInvitation.create({
      data: {
        officeId: manager.officeId,
        email: `invite-${randomUUID()}@example.test`,
        role: 'LAWYER',
        tokenHash: randomUUID(),
        expiresAt: new Date(Date.now() + DAY),
        invitedById: manager.userId,
      },
    });
    await expect(inOffice(manager, () => entitlements.assertUserSlot())).rejects.toMatchObject({
      code: 'BIZ-008',
    });
  });

  it('should refuse storage, AI requests and features beyond the plan with AUTH-103 / AUTH-102', async () => {
    const manager = await seedOffice(10);
    const quota = BigInt(FREE?.storageQuotaMb ?? 0) * 1024n * 1024n;
    await inOffice(manager, () => entitlements.assertStorageFor(quota));
    await expect(
      inOffice(manager, () => entitlements.assertStorageFor(quota + 1n)),
    ).rejects.toMatchObject({ code: 'AUTH-103' });
    // The free plan allows 5 AI requests a month: provider calls count, cache hits do not (D-130).
    const usage = (cached: boolean, succeeded = true) => ({
      officeId: manager.officeId,
      userId: manager.userId,
      feature: 'quota-test',
      provider: 'fake',
      model: 'fake-1',
      inputTokens: 1,
      outputTokens: 1,
      costUsd: '0',
      durationMs: 1,
      cached,
      succeeded,
    });
    // Cache hits and answers that failed validation (AI-004) are recorded but never counted (D-130, D-144).
    await raw.aiUsage.createMany({
      data: [...Array.from({ length: 4 }, () => usage(false)), usage(true), usage(false, false)],
    });
    await inOffice(manager, () => entitlements.assertAiQuota());
    await raw.aiUsage.create({ data: usage(false) });
    await expect(inOffice(manager, () => entitlements.assertAiQuota())).rejects.toMatchObject({
      code: 'AUTH-103',
    });
    await expect(
      inOffice(manager, () => entitlements.assertFeature('googleVisionOcr')),
    ).rejects.toMatchObject({ code: 'AUTH-102' });
  });

  it("should show the office's AI use against its plan to AI users only, office by office (D-144)", async () => {
    const manager = await seedOffice(10);
    const other = await seedOffice(10);
    const collaborator = await seedUser(manager.officeId, 'EXTERNAL_COLLABORATOR');
    const row = (officeId: string, extra: object = {}) => ({
      officeId,
      feature: 'usage-test',
      provider: 'fake',
      model: 'fake-1',
      inputTokens: 1,
      outputTokens: 1,
      costUsd: '0',
      durationMs: 1,
      ...extra,
    });
    await raw.aiUsage.createMany({
      data: [
        row(manager.officeId),
        row(manager.officeId),
        row(manager.officeId, { cached: true }),
        row(manager.officeId, { succeeded: false }),
        row(other.officeId),
      ],
    });
    const mine = await http().get('/api/v1/ai/usage').set(as(manager)).expect(200);
    expect(mine.body.data).toEqual({
      used: 2,
      quota: FREE?.aiQuotaMonthly,
      remaining: (FREE?.aiQuotaMonthly ?? 0) - 2,
      resetsAt: expect.any(String),
    });
    // The month restarts at midnight in the office's time zone (Asia/Hebron by default): 22:00 or 21:00 UTC.
    expect(mine.body.data.resetsAt).toMatch(/T2[12]:00:00.000Z$/);
    const theirs = await http().get('/api/v1/ai/usage').set(as(other)).expect(200);
    expect(theirs.body.data.used).toBe(1);
    await http().get('/api/v1/ai/usage').set(as(collaborator)).expect(403);
    const view = await http().get('/api/v1/offices/me/subscription').set(as(manager)).expect(200);
    expect(view.body.data.usage).toMatchObject({
      aiThisMonth: 2,
      aiResetsAt: mine.body.data.resetsAt,
    });
  });

  it("should count the AI month from midnight in the office's time zone and say when it resets (D-144)", async () => {
    const manager = await seedOffice(10);
    await raw.office.update({ where: { id: manager.officeId }, data: { timezone: 'Asia/Hebron' } });
    const at = (iso: string) => ({
      officeId: manager.officeId,
      feature: 'rollover-test',
      provider: 'fake',
      model: 'fake-1',
      inputTokens: 1,
      outputTokens: 1,
      costUsd: '0',
      durationMs: 1,
      createdAt: new Date(iso),
    });
    // Hebron is UTC+2 in winter: February starts at 22:00 UTC on 31 January.
    await raw.aiUsage.createMany({
      data: [at('2031-01-31T21:59:00Z'), at('2031-01-31T22:01:00Z'), at('2031-02-01T10:00:00Z')],
    });
    const now = new Date('2031-02-10T12:00:00Z');
    await expect(inOffice(manager, () => entitlements.aiCallsThisMonth(now))).resolves.toBe(2);
    await expect(inOffice(manager, () => entitlements.aiUsage(now))).resolves.toMatchObject({
      used: 2,
      resetsAt: '2031-02-28T22:00:00.000Z',
    });
    // Used up: refused with nothing remaining and the reset (the quota of PS_FREE is 5).
    await raw.aiUsage.createMany({
      data: Array.from({ length: 5 }, () => at(new Date().toISOString())),
    });
    await expect(inOffice(manager, () => entitlements.assertAiQuota())).rejects.toMatchObject({
      code: 'AUTH-103',
      details: [{ field: 'aiQuota', params: { remaining: '0', quota: '5' } }],
    });
  });
});
