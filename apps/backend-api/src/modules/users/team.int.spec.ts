import { randomUUID } from 'node:crypto';

import { JwtService } from '@nestjs/jwt';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { TeamMember, UserOpenFile } from '@nexlegtiq/shared-contracts';
import type { Role } from '@nexlegtiq/shared-types';
import request from 'supertest';

import { AppModule } from '../../app/app.module';
import { configureApp } from '../../app/configure-app';
import { integrationEnv } from '../../config/env.fixture';
import { PrismaService } from '../../database/prisma.service';
import { TENANT_MODELS } from '../../database/tenant-models';
import type { PrismaClient } from '../../generated/prisma/client';
import { bearerFor } from '../auth/auth.test-helper';
import { liveSubscription } from '../subscriptions/subscription.test-helper';

interface SeededUser {
  readonly userId: string;
  readonly officeId: string;
  readonly role: Role;
}

type Delegate = { deleteMany(args: unknown): Promise<unknown> };
type ErrorBody = { error: { code: string; details?: { field: string; message: string }[] } };

/** Team management (MVP-50, D-124) through HTTP on real PostgreSQL. */
describe('team management (HTTP + PostgreSQL)', () => {
  let app: NestExpressApplication;
  let raw: PrismaClient;
  let jwt: JwtService;
  const officeIds: string[] = [];
  const planIds: string[] = [];
  const savedEnv = { ...process.env };

  const http = () => request(app.getHttpServer());

  async function seedOffice(subscriptions: object = liveSubscription()): Promise<string> {
    const office = await raw.office.create({
      data: { name: 'Team office', settings: { create: {} }, subscriptions },
    });
    officeIds.push(office.id);
    return office.id;
  }

  async function seedUser(
    officeId: string,
    role: Role,
    fullName: string = role,
  ): Promise<SeededUser> {
    const user = await raw.user.create({
      data: {
        officeId,
        fullName,
        email: `team-${randomUUID()}@example.test`,
        passwordHash: '!',
        role,
      },
    });
    return { userId: user.id, officeId, role };
  }

  async function seedFile(lawyer: SeededUser, status: 'OPEN' | 'CLOSED' = 'OPEN') {
    const file = await raw.legalFile.create({
      data: {
        officeId: lawyer.officeId,
        fileNumber: `T-${randomUUID().slice(0, 8)}`,
        title: 'Team file',
        fileType: 'LITIGATION',
        status,
        responsibleLawyerId: lawyer.userId,
        jurisdiction: 'PALESTINE',
        currency: 'ILS',
      },
    });
    await raw.fileTeamMember.create({
      data: {
        officeId: lawyer.officeId,
        fileId: file.id,
        userId: lawyer.userId,
        role: 'RESPONSIBLE_LAWYER',
      },
    });
    return file;
  }

  async function office() {
    const officeId = await seedOffice();
    return {
      officeId,
      manager: await seedUser(officeId, 'OFFICE_MANAGER', 'Basma Manager'),
      lawyer: await seedUser(officeId, 'LAWYER', 'Adel Lawyer'),
      senior: await seedUser(officeId, 'SENIOR_LAWYER', 'Salma Senior'),
    };
  }

  beforeAll(async () => {
    Object.assign(process.env, integrationEnv(), { EMAIL_VERIFICATION_ENFORCED: 'false' });
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = module.createNestApplication<NestExpressApplication>({ bufferLogs: true });
    configureApp(app);
    await app.init();
    // unscoped: test fixtures across offices.
    raw = app.get(PrismaService).unscoped();
    jwt = app.get(JwtService);
  }, 60_000);

  afterAll(async () => {
    if (raw) {
      const where = { officeId: { in: officeIds } };
      for (const model of [...TENANT_MODELS].filter((name) => name !== 'User').reverse()) {
        const delegate = (raw as unknown as Record<string, Delegate>)[
          model.charAt(0).toLowerCase() + model.slice(1)
        ];
        await delegate?.deleteMany({ where });
      }
      await raw.user.deleteMany({ where });
      await raw.office.deleteMany({ where: { id: { in: officeIds } } });
      await raw.plan.deleteMany({ where: { id: { in: planIds } } });
    }
    await app?.close();
    process.env = savedEnv;
  });

  it('should list the team with open-file counts, active first, and nobody from another office', async () => {
    const { manager, lawyer, senior, officeId } = await office();
    await seedFile(lawyer);
    await seedFile(lawyer, 'CLOSED');
    await raw.user.update({ where: { id: senior.userId }, data: { isActive: false } });
    await seedUser(await seedOffice(), 'LAWYER', 'Other Office');

    const res = await http().get('/api/v1/users').set(bearerFor(jwt, manager)).expect(200);
    const team = (res.body as { data: TeamMember[] }).data;
    expect(team.map((m) => [m.fullName, m.isActive, m.openFiles])).toEqual([
      ['Adel Lawyer', true, 1],
      ['Basma Manager', true, 0],
      ['Salma Senior', false, 0],
    ]);
    expect(team[0]).toMatchObject({ role: 'LAWYER', lastLoginAt: null });
    expect(team.every((m) => m.email.endsWith('@example.test'))).toBe(true);
    expect(officeId).toBeDefined();
  });

  it.each(['SENIOR_LAWYER', 'LAWYER', 'ADMIN'] as const)(
    'should refuse team management to a %s (403 AUTH-100)',
    async (role) => {
      const { lawyer } = await office();
      const user = await seedUser(lawyer.officeId, role);
      await http().get('/api/v1/users').set(bearerFor(jwt, user)).expect(403);
      await http()
        .patch(`/api/v1/users/${lawyer.userId}/role`)
        .set(bearerFor(jwt, user))
        .send({ role: 'PARALEGAL' })
        .expect(403);
      await http()
        .post(`/api/v1/users/${lawyer.userId}/deactivate`)
        .set(bearerFor(jwt, user))
        .send({})
        .expect(403);
    },
  );

  it("should answer 404 for another office's user and a malformed id", async () => {
    const { manager } = await office();
    const stranger = await seedUser(await seedOffice(), 'LAWYER');
    for (const req of [
      () => http().get(`/api/v1/users/${stranger.userId}/open-files`),
      () => http().patch(`/api/v1/users/${stranger.userId}/role`).send({ role: 'PARALEGAL' }),
      () => http().post(`/api/v1/users/${stranger.userId}/deactivate`).send({}),
      () => http().post(`/api/v1/users/${stranger.userId}/reactivate`),
      () => http().post('/api/v1/users/not-a-uuid/reactivate'),
    ]) {
      const res = await req().set(bearerFor(jwt, manager)).expect(404);
      expect((res.body as ErrorBody).error.code).toBe('RES-001');
    }
    expect((await raw.user.findUniqueOrThrow({ where: { id: stranger.userId } })).isActive).toBe(
      true,
    );
  });

  it('should change a role, and never demote or deactivate the last office manager (BIZ-001)', async () => {
    const { manager, lawyer } = await office();
    const changed = await http()
      .patch(`/api/v1/users/${lawyer.userId}/role`)
      .set(bearerFor(jwt, manager))
      .send({ role: 'SENIOR_LAWYER' })
      .expect(200);
    expect((changed.body as { data: TeamMember }).data.role).toBe('SENIOR_LAWYER');

    const demote = await http()
      .patch(`/api/v1/users/${manager.userId}/role`)
      .set(bearerFor(jwt, manager))
      .send({ role: 'LAWYER' })
      .expect(422);
    expect((demote.body as ErrorBody).error.code).toBe('BIZ-001');
    const deactivate = await http()
      .post(`/api/v1/users/${manager.userId}/deactivate`)
      .set(bearerFor(jwt, manager))
      .send({})
      .expect(422);
    expect((deactivate.body as ErrorBody).error.code).toBe('BIZ-001');

    // With a second manager, the first may step down.
    await seedUser(manager.officeId, 'OFFICE_MANAGER');
    await http()
      .patch(`/api/v1/users/${manager.userId}/role`)
      .set(bearerFor(jwt, manager))
      .send({ role: 'LAWYER' })
      .expect(200);
    const audit = await raw.auditLog.findFirst({
      where: { entityId: manager.userId, action: 'UPDATE' },
    });
    expect(audit?.newValues).toEqual({ role: 'LAWYER' });
  });

  it('should refuse a non-lawyer role for a responsible lawyer with open files', async () => {
    const { manager, lawyer } = await office();
    await seedFile(lawyer);
    const res = await http()
      .patch(`/api/v1/users/${lawyer.userId}/role`)
      .set(bearerFor(jwt, manager))
      .send({ role: 'PARALEGAL' })
      .expect(400);
    expect((res.body as ErrorBody).error.details).toEqual([
      expect.objectContaining({ field: 'role', message: 'validation.roleHasOpenFiles' }),
    ]);
  });

  it('should reject a partial or invalid reassignment and change nothing', async () => {
    const { manager, lawyer, senior } = await office();
    const [a, b] = [await seedFile(lawyer), await seedFile(lawyer)];
    const paralegal = await seedUser(lawyer.officeId, 'PARALEGAL');

    const files = await http()
      .get(`/api/v1/users/${lawyer.userId}/open-files`)
      .set(bearerFor(jwt, manager))
      .expect(200);
    expect((files.body as { data: UserOpenFile[] }).data.map((f) => f.id).sort()).toEqual(
      [a.id, b.id].sort(),
    );

    const partial = await http()
      .post(`/api/v1/users/${lawyer.userId}/deactivate`)
      .set(bearerFor(jwt, manager))
      .send({ reassignments: [{ fileId: a.id, newResponsibleLawyerId: senior.userId }] })
      .expect(400);
    expect((partial.body as ErrorBody).error.details?.[0]?.message).toBe(
      'validation.reassignAllFiles',
    );
    const wrongRole = await http()
      .post(`/api/v1/users/${lawyer.userId}/deactivate`)
      .set(bearerFor(jwt, manager))
      .send({
        reassignments: [
          { fileId: a.id, newResponsibleLawyerId: senior.userId },
          { fileId: b.id, newResponsibleLawyerId: paralegal.userId },
        ],
      })
      .expect(400);
    expect((wrongRole.body as ErrorBody).error.details).toEqual([
      expect.objectContaining({ field: 'reassignments.1.newResponsibleLawyerId' }),
    ]);
    const user = await raw.user.findUniqueOrThrow({ where: { id: lawyer.userId } });
    expect(user.isActive).toBe(true);
    expect(
      (await raw.legalFile.findUniqueOrThrow({ where: { id: a.id } })).responsibleLawyerId,
    ).toBe(lawyer.userId);
  });

  it('should deactivate with reassignment: sessions revoked, team, timeline, notification and reminders', async () => {
    const { manager, lawyer, senior } = await office();
    const file = await seedFile(lawyer);
    const closed = await seedFile(lawyer, 'CLOSED');
    await raw.refreshToken.create({
      data: {
        officeId: lawyer.officeId,
        userId: lawyer.userId,
        familyId: randomUUID(),
        tokenHash: randomUUID(),
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    const session = await raw.session.create({
      data: {
        officeId: lawyer.officeId,
        fileId: file.id,
        startsAt: new Date(Date.now() + 10 * 86_400_000),
        attendingLawyerId: senior.userId,
        createdById: manager.userId,
        reminderDays: [1],
      },
    });

    const res = await http()
      .post(`/api/v1/users/${lawyer.userId}/deactivate`)
      .set(bearerFor(jwt, manager))
      .send({ reassignments: [{ fileId: file.id, newResponsibleLawyerId: senior.userId }] })
      .expect(200);
    expect((res.body as { data: TeamMember }).data).toMatchObject({
      isActive: false,
      openFiles: 0,
    });

    expect(
      await raw.refreshToken.count({ where: { userId: lawyer.userId, revokedAt: null } }),
    ).toBe(0);
    expect(
      (await raw.legalFile.findUniqueOrThrow({ where: { id: file.id } })).responsibleLawyerId,
    ).toBe(senior.userId);
    expect(
      (await raw.legalFile.findUniqueOrThrow({ where: { id: closed.id } })).responsibleLawyerId,
    ).toBe(lawyer.userId);
    expect(
      await raw.fileTeamMember.findMany({
        where: { fileId: file.id },
        select: { userId: true, role: true },
      }),
    ).toEqual([{ userId: senior.userId, role: 'RESPONSIBLE_LAWYER' }]);
    const event = await raw.caseTimelineEvent.findFirstOrThrow({
      where: { fileId: file.id, eventType: 'FILE_REASSIGNED' },
    });
    expect(event.payload).toEqual({
      fromUserId: lawyer.userId,
      toUserId: senior.userId,
      reason: 'DEACTIVATION',
    });
    const notification = await raw.notification.findFirstOrThrow({
      where: { userId: senior.userId },
    });
    expect(notification).toMatchObject({
      type: 'file.reassigned',
      titleKey: 'shell.notifications.fileReassigned',
      link: `/cases/${file.id}`,
    });
    expect(
      await raw.sessionReminder.count({ where: { sessionId: session.id, status: 'PENDING' } }),
    ).toBe(1);

    // The deactivated user's token stops working at once (D-082).
    await http().get('/api/v1/users/directory').set(bearerFor(jwt, lawyer)).expect(403);
    // Again: nothing to do.
    await http()
      .post(`/api/v1/users/${lawyer.userId}/deactivate`)
      .set(bearerFor(jwt, manager))
      .send({})
      .expect(200);
  });

  it('should reactivate only within the plan user limit (BIZ-008)', async () => {
    const plan = await raw.plan.create({
      data: {
        code: `TEAM_TEST_${randomUUID().slice(0, 8)}`,
        name: 'Two seats',
        market: 'GLOBAL',
        priceMonthly: '0',
        currency: 'USD',
        maxUsers: 2,
        storageQuotaMb: 100,
        features: {},
      },
    });
    planIds.push(plan.id);
    const officeId = await seedOffice({
      create: { status: 'ACTIVE', currentPeriodStart: new Date(), planId: plan.id },
    });
    const manager = await seedUser(officeId, 'OFFICE_MANAGER');
    const leaver = await seedUser(officeId, 'LAWYER');
    await http()
      .post(`/api/v1/users/${leaver.userId}/deactivate`)
      .set(bearerFor(jwt, manager))
      .send({})
      .expect(200);
    await seedUser(officeId, 'PARALEGAL');

    const full = await http()
      .post(`/api/v1/users/${leaver.userId}/reactivate`)
      .set(bearerFor(jwt, manager))
      .expect(422);
    expect((full.body as ErrorBody).error.code).toBe('BIZ-008');

    await raw.user.updateMany({
      where: { officeId, role: 'PARALEGAL' },
      data: { isActive: false },
    });
    const ok = await http()
      .post(`/api/v1/users/${leaver.userId}/reactivate`)
      .set(bearerFor(jwt, manager))
      .expect(200);
    expect((ok.body as { data: TeamMember }).data.isActive).toBe(true);
  });
});
