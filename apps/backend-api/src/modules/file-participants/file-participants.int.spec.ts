import { randomUUID } from 'node:crypto';

import { JwtService } from '@nestjs/jwt';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { FileClient, FileTeamMember } from '@nexlegtiq/shared-contracts';
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

type Delegate = { deleteMany(args: unknown): Promise<unknown> };
type ErrorBody = { error: { code: string; details?: { field: string; message: string }[] } };
interface Seeded {
  readonly userId: string;
  readonly officeId: string;
  readonly role: Role;
}

/** Clients and team of a file (MVP-61, D-140) through HTTP on real PostgreSQL. */
describe('file clients and team (HTTP + PostgreSQL)', () => {
  let app: NestExpressApplication;
  let raw: PrismaClient;
  let jwt: JwtService;
  const officeIds: string[] = [];
  const savedEnv = { ...process.env };
  const http = () => request(app.getHttpServer());
  const as = (who: Seeded) => bearerFor(jwt, who);

  async function office() {
    const created = await raw.office.create({
      data: { name: 'Team office', settings: { create: {} }, subscriptions: liveSubscription() },
    });
    officeIds.push(created.id);
    return { officeId: created.id, manager: await user(created.id, 'OFFICE_MANAGER') };
  }

  async function user(officeId: string, role: Role, isActive = true): Promise<Seeded> {
    const row = await raw.user.create({
      data: {
        officeId,
        fullName: `${role} ${randomUUID().slice(0, 4)}`,
        email: `team-${randomUUID()}@example.test`,
        passwordHash: '!',
        role,
        isActive,
      },
    });
    return { userId: row.id, officeId, role };
  }

  async function client(officeId: string, displayName: string) {
    return raw.client.create({ data: { officeId, clientType: 'INDIVIDUAL', displayName } });
  }

  async function file(
    lawyer: Seeded,
    extra: { isConfidential?: boolean; status?: 'OPEN' | 'ARCHIVED' } = {},
  ) {
    const created = await raw.legalFile.create({
      data: {
        officeId: lawyer.officeId,
        fileNumber: `T-${randomUUID().slice(0, 8)}`,
        title: 'Team file',
        fileType: 'LITIGATION',
        status: extra.status ?? 'OPEN',
        isConfidential: extra.isConfidential ?? false,
        responsibleLawyerId: lawyer.userId,
        jurisdiction: 'PALESTINE',
        currency: 'ILS',
      },
    });
    await raw.fileTeamMember.create({
      data: {
        officeId: lawyer.officeId,
        fileId: created.id,
        userId: lawyer.userId,
        role: 'RESPONSIBLE_LAWYER',
      },
    });
    const primary = await client(lawyer.officeId, 'Primary client');
    await raw.fileClient.create({
      data: {
        officeId: lawyer.officeId,
        fileId: created.id,
        clientId: primary.id,
        isPrimary: true,
      },
    });
    return { ...created, primaryClientId: primary.id };
  }

  const events = (fileId: string) =>
    raw.caseTimelineEvent.findMany({ where: { fileId }, select: { eventType: true } });
  const audits = (fileId: string, entityType: string) =>
    raw.auditLog.findMany({ where: { entityId: fileId, entityType }, select: { action: true } });

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
      await raw.subscription.deleteMany({ where });
      await raw.office.deleteMany({ where: { id: { in: officeIds } } });
    }
    await app?.close();
    process.env = savedEnv;
  });

  describe('clients', () => {
    it('should add clients, make one primary, promote on removal and keep the last one', async () => {
      const { officeId, manager } = await office();
      const target = await file(manager);
      const second = await client(officeId, 'Second client');
      const base = `/api/v1/cases/${target.id}/clients`;

      const added = await http()
        .post(base)
        .set(as(manager))
        .send({ clientId: second.id, isPrimary: true })
        .expect(201);
      expect((added.body as { data: FileClient[] }).data).toEqual([
        expect.objectContaining({ id: second.id, isPrimary: true }),
        expect.objectContaining({ id: target.primaryClientId, isPrimary: false }),
      ]);
      await http().post(base).set(as(manager)).send({ clientId: second.id }).expect(409);

      await http()
        .patch(`${base}/${target.primaryClientId}`)
        .set(as(manager))
        .send({ isPrimary: true })
        .expect(200);
      // Removing the primary makes the oldest remaining client primary.
      await http().delete(`${base}/${target.primaryClientId}`).set(as(manager)).expect(204);
      const left = await http().get(base).set(as(manager)).expect(200);
      expect((left.body as { data: FileClient[] }).data).toEqual([
        expect.objectContaining({ id: second.id, isPrimary: true }),
      ]);
      const last = await http().delete(`${base}/${second.id}`).set(as(manager)).expect(422);
      expect((last.body as ErrorBody).error.code).toBe('BIZ-018');

      expect((await events(target.id)).map((event) => event.eventType)).toEqual(
        expect.arrayContaining(['CLIENT_ADDED', 'CLIENT_REMOVED']),
      );
      expect((await audits(target.id, 'FileClient')).map((row) => row.action).sort()).toEqual([
        'CREATE',
        'DELETE',
        'UPDATE',
      ]);
    });

    it("should refuse another office's client and hide another office's file", async () => {
      const mine = await office();
      const theirs = await office();
      const target = await file(mine.manager);
      const foreign = await client(theirs.officeId, 'Foreign');
      const res = await http()
        .post(`/api/v1/cases/${target.id}/clients`)
        .set(as(mine.manager))
        .send({ clientId: foreign.id })
        .expect(400);
      expect((res.body as ErrorBody).error.details?.[0]).toEqual({
        field: 'clientId',
        message: 'validation.unknownClient',
      });
      await http().get(`/api/v1/cases/${target.id}/clients`).set(as(theirs.manager)).expect(404);
      await http().get(`/api/v1/cases/${target.id}/team`).set(as(theirs.manager)).expect(404);
    });
  });

  describe('team', () => {
    it('should give a lawyer access when added and take it away when removed, and notify them', async () => {
      const { officeId, manager } = await office();
      const target = await file(manager);
      const lawyer = await user(officeId, 'LAWYER');
      await http().get(`/api/v1/cases/${target.id}`).set(as(lawyer)).expect(404);

      const added = await http()
        .post(`/api/v1/cases/${target.id}/team`)
        .set(as(manager))
        .send({ userId: lawyer.userId })
        .expect(201);
      expect((added.body as { data: FileTeamMember[] }).data).toEqual([
        expect.objectContaining({ id: manager.userId, role: 'RESPONSIBLE_LAWYER' }),
        expect.objectContaining({ id: lawyer.userId, role: 'MEMBER' }),
      ]);
      await http().get(`/api/v1/cases/${target.id}`).set(as(lawyer)).expect(200);
      const listed = await http().get('/api/v1/cases').set(as(lawyer)).expect(200);
      expect((listed.body as { data: { id: string }[] }).data.map((row) => row.id)).toContain(
        target.id,
      );
      await expect(
        raw.notification.count({ where: { userId: lawyer.userId, type: 'file.teamAdded' } }),
      ).resolves.toBe(1);

      await http()
        .delete(`/api/v1/cases/${target.id}/team/${lawyer.userId}`)
        .set(as(manager))
        .expect(204);
      await http().get(`/api/v1/cases/${target.id}`).set(as(lawyer)).expect(404);
      expect((await events(target.id)).map((event) => event.eventType)).toEqual(
        expect.arrayContaining(['TEAM_MEMBER_ADDED', 'TEAM_MEMBER_REMOVED']),
      );
    });

    it("should refuse another office's user (404) and an inactive or ineligible colleague (400)", async () => {
      const mine = await office();
      const theirs = await office();
      const target = await file(mine.manager);
      const team = `/api/v1/cases/${target.id}/team`;
      await http()
        .post(team)
        .set(as(mine.manager))
        .send({ userId: theirs.manager.userId })
        .expect(404);
      const gone = await user(mine.officeId, 'LAWYER', false);
      await http().post(team).set(as(mine.manager)).send({ userId: gone.userId }).expect(400);
      const trainee = await user(mine.officeId, 'TRAINEE');
      const res = await http()
        .post(team)
        .set(as(mine.manager))
        .send({ userId: trainee.userId, role: 'PARALEGAL' })
        .expect(400);
      expect((res.body as ErrorBody).error.details?.[0]?.message).toBe(
        'validation.responsibleParalegal',
      );
      await http()
        .post(team)
        .set(as(mine.manager))
        .send({ userId: mine.manager.userId })
        .expect(409);
    });

    it('should reassign the file when someone becomes responsible lawyer, and keep one at all times', async () => {
      const { officeId, manager } = await office();
      const target = await file(manager);
      const lawyer = await user(officeId, 'LAWYER');
      const team = `/api/v1/cases/${target.id}/team`;
      await http().post(team).set(as(manager)).send({ userId: lawyer.userId }).expect(201);
      // A lawyer with edit:assigned:case may edit the file but not reassign it (D-118).
      await http()
        .patch(`${team}/${lawyer.userId}`)
        .set(as(lawyer))
        .send({ role: 'RESPONSIBLE_LAWYER' })
        .expect(403);

      const res = await http()
        .patch(`${team}/${lawyer.userId}`)
        .set(as(manager))
        .send({ role: 'RESPONSIBLE_LAWYER' })
        .expect(200);
      expect((res.body as { data: FileTeamMember[] }).data).toEqual([
        expect.objectContaining({ id: lawyer.userId, role: 'RESPONSIBLE_LAWYER' }),
        expect.objectContaining({ id: manager.userId, role: 'MEMBER' }),
      ]);
      await expect(
        raw.legalFile.findUniqueOrThrow({
          where: { id: target.id },
          select: { responsibleLawyerId: true },
        }),
      ).resolves.toEqual({ responsibleLawyerId: lawyer.userId });
      expect((await events(target.id)).map((event) => event.eventType)).toContain(
        'FILE_REASSIGNED',
      );
      await expect(
        raw.notification.count({ where: { userId: lawyer.userId, type: 'file.reassigned' } }),
      ).resolves.toBe(1);

      const removal = await http().delete(`${team}/${lawyer.userId}`).set(as(manager)).expect(422);
      expect((removal.body as ErrorBody).error.code).toBe('BIZ-019');
      await http()
        .patch(`${team}/${lawyer.userId}`)
        .set(as(manager))
        .send({ role: 'MEMBER' })
        .expect(422);
    });

    it('should keep the responsible paralegal in sync with the PARALEGAL role', async () => {
      const { officeId, manager } = await office();
      const target = await file(manager);
      const first = await user(officeId, 'PARALEGAL');
      const second = await user(officeId, 'PARALEGAL');
      const team = `/api/v1/cases/${target.id}/team`;
      const paralegal = async () =>
        (
          await raw.legalFile.findUniqueOrThrow({
            where: { id: target.id },
            select: { responsibleParalegalId: true },
          })
        ).responsibleParalegalId;

      await http()
        .post(team)
        .set(as(manager))
        .send({ userId: first.userId, role: 'PARALEGAL' })
        .expect(201);
      await expect(paralegal()).resolves.toBe(first.userId);
      const res = await http()
        .post(team)
        .set(as(manager))
        .send({ userId: second.userId, role: 'PARALEGAL' })
        .expect(201);
      expect((res.body as { data: FileTeamMember[] }).data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: second.userId, role: 'PARALEGAL' }),
          expect.objectContaining({ id: first.userId, role: 'MEMBER' }),
        ]),
      );
      await expect(paralegal()).resolves.toBe(second.userId);
      await http().delete(`${team}/${second.userId}`).set(as(manager)).expect(204);
      await expect(paralegal()).resolves.toBeNull();
    });

    it('should let only the office manager or responsible lawyer add people to a confidential file', async () => {
      const { officeId, manager } = await office();
      const lawyer = await user(officeId, 'LAWYER');
      const target = await file(lawyer, { isConfidential: true });
      const paralegal = await user(officeId, 'PARALEGAL');
      const colleague = await user(officeId, 'LAWYER');
      const team = `/api/v1/cases/${target.id}/team`;
      await http().post(team).set(as(manager)).send({ userId: paralegal.userId }).expect(201);
      // The paralegal now sees the file and may edit it, but not expose it to someone else.
      await http().post(team).set(as(paralegal)).send({ userId: colleague.userId }).expect(403);
      await http().post(team).set(as(lawyer)).send({ userId: colleague.userId }).expect(201);
    });

    it('should refuse changes on an archived file', async () => {
      const { officeId, manager } = await office();
      const target = await file(manager, { status: 'ARCHIVED' });
      const lawyer = await user(officeId, 'LAWYER');
      const res = await http()
        .post(`/api/v1/cases/${target.id}/team`)
        .set(as(manager))
        .send({ userId: lawyer.userId })
        .expect(422);
      expect((res.body as ErrorBody).error.code).toBe('BIZ-007');
    });
  });
});
