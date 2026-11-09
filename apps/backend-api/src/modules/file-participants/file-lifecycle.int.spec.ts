import { randomUUID } from 'node:crypto';

import { JwtService } from '@nestjs/jwt';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Role } from '@nexlegtiq/shared-types';
import request from 'supertest';

import { AppModule } from '../../app/app.module';
import { configureApp } from '../../app/configure-app';
import { integrationEnv } from '../../config/env.fixture';
import { PrismaService } from '../../database/prisma.service';
import type { PrismaClient } from '../../generated/prisma/client';
import { bearerFor } from '../auth/auth.test-helper';
import { liveSubscription } from '../subscriptions/subscription.test-helper';

type Person = { userId: string; officeId: string; role: Role };
const DAY = 86_400_000;

/** D-153 on real PostgreSQL: close, reopen, archive and reassign, with who may and the side effects. */
describe('file lifecycle (HTTP + PostgreSQL)', () => {
  let app: NestExpressApplication;
  let raw: PrismaClient;
  let jwt: JwtService;
  let manager: Person;
  let lawyer: Person;
  let colleague: Person;
  let senior: Person;
  let paralegal: Person;
  let other: Person;
  const officeIds: string[] = [];
  const savedEnv = { ...process.env };
  const http = () => request(app.getHttpServer());

  async function office(name: string) {
    const row = await raw.office.create({
      data: { name, settings: { create: {} }, subscriptions: liveSubscription() },
    });
    officeIds.push(row.id);
    return async (role: Role, fullName: string = role): Promise<Person> => {
      const user = await raw.user.create({
        data: {
          officeId: row.id,
          fullName,
          email: `lc-${randomUUID()}@example.test`,
          passwordHash: '!',
          role,
        },
      });
      return { userId: user.id, officeId: row.id, role };
    };
  }

  /** A file of the lawyer, with a hearing in 10 days and its pending reminder. */
  async function file(withOpenTask: boolean) {
    const officeId = manager.officeId;
    const row = await raw.legalFile.create({
      data: {
        officeId,
        fileNumber: `LC-${randomUUID()}`,
        title: 'Rent claim',
        fileType: 'LITIGATION',
        responsibleLawyerId: lawyer.userId,
        jurisdiction: 'PALESTINE',
        currency: 'ILS',
        openingDate: new Date(Date.now() - 30 * DAY),
      },
    });
    await raw.fileTeamMember.create({
      data: { officeId, fileId: row.id, userId: lawyer.userId, role: 'RESPONSIBLE_LAWYER' },
    });
    const session = await raw.session.create({
      data: {
        officeId,
        fileId: row.id,
        startsAt: new Date(Date.now() + 10 * DAY),
        attendingLawyerId: lawyer.userId,
        createdById: lawyer.userId,
        reminderDays: [3],
      },
    });
    await raw.sessionReminder.create({
      data: {
        officeId,
        sessionId: session.id,
        recipientId: lawyer.userId,
        daysBefore: 3,
        scheduledFor: new Date(Date.now() + 7 * DAY),
      },
    });
    if (withOpenTask) {
      await raw.task.create({
        data: {
          officeId,
          fileId: row.id,
          title: 'Reply',
          assignedToId: lawyer.userId,
          createdById: lawyer.userId,
        },
      });
    }
    return row.id;
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
    // unscoped: fixtures for two offices and checks across them.
    raw = app.get(PrismaService).unscoped();
    jwt = app.get(JwtService);
    const inA = await office('Lifecycle office A');
    manager = await inA('OFFICE_MANAGER', 'Layla Manager');
    lawyer = await inA('LAWYER', 'Omar Lawyer');
    colleague = await inA('LAWYER', 'Sami Colleague');
    senior = await inA('SENIOR_LAWYER', 'Hana Senior');
    paralegal = await inA('PARALEGAL', 'Rana Paralegal');
    other = await (await office('Lifecycle office B'))('OFFICE_MANAGER');
  }, 60_000);

  afterAll(async () => {
    if (raw) {
      const where = { officeId: { in: officeIds } };
      await raw.notification.deleteMany({ where });
      await raw.sessionReminder.deleteMany({ where });
      await raw.session.deleteMany({ where });
      await raw.task.deleteMany({ where });
      await raw.caseTimelineEvent.deleteMany({ where });
      await raw.fileTeamMember.deleteMany({ where });
      await raw.legalFile.deleteMany({ where });
      await raw.auditLog.deleteMany({ where });
      await raw.subscription.deleteMany({ where });
      await raw.officeSettings.deleteMany({ where });
      await raw.user.deleteMany({ where });
      await raw.office.deleteMany({ where: { id: { in: officeIds } } });
    }
    await app?.close();
    process.env = savedEnv;
  });

  const post = (person: Person, fileId: string, action: string, body: object = {}) =>
    http().post(`/api/v1/cases/${fileId}/${action}`).set(bearerFor(jwt, person)).send(body);

  it('should close only for the responsible lawyer (or OM/SL), block on open tasks unless forced, and end reminders', async () => {
    const fileId = await file(true);
    // A lawyer off the file does not see it (D-051): 404, not 403.
    expect((await post(colleague, fileId, 'close')).status).toBe(404);
    expect((await post(paralegal, fileId, 'close')).status).toBe(403);
    // On the team but not the responsible lawyer: a LAWYER may not close (D-052).
    await raw.fileTeamMember.create({
      data: { officeId: manager.officeId, fileId, userId: colleague.userId, role: 'MEMBER' },
    });
    expect((await post(colleague, fileId, 'close')).status).toBe(403);
    await raw.fileTeamMember.deleteMany({ where: { fileId, userId: colleague.userId } });
    expect((await post(other, fileId, 'close')).status).toBe(404);
    const blocked = await post(lawyer, fileId, 'close', { reason: 'Settled' });
    expect(blocked.status).toBe(422);
    expect(blocked.body.error).toMatchObject({
      code: 'BIZ-003',
      details: [expect.objectContaining({ params: { openTasks: '1' } })],
    });
    expect((await post(lawyer, fileId, 'close', { force: true })).status).toBe(400);
    expect(
      (await post(lawyer, fileId, 'close', { force: true, forceReason: 'Client withdrew' })).status,
    ).toBe(204);
    const closed = await raw.legalFile.findUniqueOrThrow({ where: { id: fileId } });
    expect(closed.status).toBe('CLOSED');
    expect(closed.closingDate).not.toBeNull();
    expect(
      await raw.sessionReminder.count({ where: { session: { fileId }, status: 'PENDING' } }),
    ).toBe(0);
    const event = await raw.caseTimelineEvent.findFirst({
      where: { fileId, eventType: 'FILE_CLOSED' },
    });
    // The reasons are staff notes: audited, never on the portal-visible timeline (D-150).
    expect(event?.payload).toEqual({ openTasks: 1 });
    expect((await post(lawyer, fileId, 'close')).body.error.code).toBe('BIZ-002');
    // Archiving: the office manager and senior lawyers, and only a closed file; afterwards read-only.
    expect((await post(lawyer, fileId, 'archive')).status).toBe(403);
    expect((await post(senior, fileId, 'archive')).status).toBe(204);
    expect((await post(senior, fileId, 'archive')).body.error.code).toBe('BIZ-007');
    expect((await post(manager, fileId, 'reopen')).body.error.code).toBe('BIZ-007');
  });

  it('should reopen a closed file and schedule its upcoming reminders again', async () => {
    const fileId = await file(false);
    expect((await post(manager, fileId, 'reopen')).status).toBe(409);
    expect((await post(senior, fileId, 'archive')).status).toBe(409);
    expect((await post(lawyer, fileId, 'close')).status).toBe(204);
    expect((await post(lawyer, fileId, 'reopen')).status).toBe(204);
    const reopened = await raw.legalFile.findUniqueOrThrow({ where: { id: fileId } });
    expect(reopened).toMatchObject({ status: 'OPEN', closingDate: null });
    expect(
      await raw.sessionReminder.count({ where: { session: { fileId }, status: 'PENDING' } }),
    ).toBeGreaterThan(0);
    expect(
      await raw.caseTimelineEvent.count({ where: { fileId, eventType: 'FILE_REOPENED' } }),
    ).toBe(1);
  });

  it('should reassign the file, tell both lawyers and keep the previous one on the team', async () => {
    const fileId = await file(true);
    const body = { newResponsibleLawyerId: colleague.userId, note: 'Lawyer on leave' };
    expect((await post(lawyer, fileId, 'reassign', body)).status).toBe(403);
    expect((await post(other, fileId, 'reassign', body)).status).toBe(404);
    const res = await post(manager, fileId, 'reassign', body);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: colleague.userId, role: 'RESPONSIBLE_LAWYER' }),
        expect.objectContaining({ id: lawyer.userId, role: 'MEMBER' }),
      ]),
    );
    expect(
      (await raw.legalFile.findUniqueOrThrow({ where: { id: fileId } })).responsibleLawyerId,
    ).toBe(colleague.userId);
    const notes = await raw.notification.findMany({
      where: { params: { path: ['fileId'], equals: fileId } },
    });
    expect(notes.map((n) => [n.userId, n.titleKey]).sort()).toEqual(
      [
        [colleague.userId, 'shell.notifications.fileReassigned'],
        [lawyer.userId, 'shell.notifications.fileReassignedAway'],
      ].sort(),
    );
    const event = await raw.caseTimelineEvent.findFirst({
      where: { fileId, eventType: 'FILE_REASSIGNED' },
    });
    expect(event?.payload).toMatchObject({ reason: 'REASSIGN', note: 'Lawyer on leave' });
    // Tasks stay with their assignee.
    expect((await raw.task.findFirstOrThrow({ where: { fileId } })).assignedToId).toBe(
      lawyer.userId,
    );
  });
});
