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

  it('should show the plan, limits, flags and usage to every user of the office', async () => {
    const manager = await seedOffice(10);
    const trainee = await seedUser(manager.officeId, 'TRAINEE');
    const res = await http().get('/api/v1/offices/me/subscription').set(as(trainee)).expect(200);
    expect((res.body as { data: OfficeSubscription }).data).toMatchObject({
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
    await inOffice(manager, () => entitlements.assertAiQuota(4));
    await expect(inOffice(manager, () => entitlements.assertAiQuota(5))).rejects.toMatchObject({
      code: 'AUTH-103',
    });
    await expect(
      inOffice(manager, () => entitlements.assertFeature('googleVisionOcr')),
    ).rejects.toMatchObject({ code: 'AUTH-102' });
  });
});
