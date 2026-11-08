import { randomUUID } from 'node:crypto';

import { JwtService } from '@nestjs/jwt';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Role } from '@nexlegtiq/shared-types';
import { wallClock } from '@nexlegtiq/shared-utils';
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
const ZONE = 'Asia/Hebron';
const dateOnly = (offsetDays: number) =>
  new Date(`${wallClock(new Date(Date.now() + offsetDays * DAY), ZONE).date}T00:00:00Z`);

/** D-151 on real PostgreSQL: the numbers of `GET /dashboard` per role, from seeded fixtures in two offices. */
describe('dashboard (HTTP + PostgreSQL)', () => {
  let app: NestExpressApplication;
  let raw: PrismaClient;
  let jwt: JwtService;
  let manager: Person;
  let lawyer: Person;
  let trainee: Person;
  let other: Person;
  let fileId: string;
  let soonId: string;
  const officeIds: string[] = [];
  const savedEnv = { ...process.env };
  const soon = new Date(Date.now() + 30 * 60_000);

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
          email: `db-${randomUUID()}@example.test`,
          passwordHash: '!',
          role,
        },
      });
      return { userId: user.id, officeId: row.id, role };
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
    // unscoped: fixtures for two offices and checks across them.
    raw = app.get(PrismaService).unscoped();
    jwt = app.get(JwtService);
    const inA = await office('Dashboard office A');
    manager = await inA('OFFICE_MANAGER', 'Layla Manager');
    lawyer = await inA('LAWYER', 'Omar Lawyer');
    trainee = await inA('TRAINEE', 'Tala Trainee');
    other = await (await office('Dashboard office B'))('OFFICE_MANAGER');
    const officeId = manager.officeId;
    const file = (title: string, openingDaysAgo: number) =>
      raw.legalFile.create({
        data: {
          officeId,
          fileNumber: `DB-${randomUUID()}`,
          title,
          fileType: 'LITIGATION',
          responsibleLawyerId: lawyer.userId,
          jurisdiction: 'PALESTINE',
          currency: 'ILS',
          openingDate: dateOnly(-openingDaysAgo),
        },
      });
    const fresh = await file('Rent claim', 0);
    await file('Old land dispute', 30);
    fileId = fresh.id;
    const session = (startsAt: Date, isCancelled = false) =>
      raw.session.create({
        data: {
          officeId,
          fileId,
          startsAt,
          attendingLawyerId: lawyer.userId,
          createdById: manager.userId,
          reminderDays: [],
          isCancelled,
        },
      });
    soonId = (await session(soon)).id;
    await session(new Date(Date.now() + 3 * DAY));
    await session(new Date(Date.now() + 2 * DAY), true);
    const task = (title: string, dueInDays: number) =>
      raw.task.create({
        data: {
          officeId,
          fileId,
          title,
          assignedToId: lawyer.userId,
          createdById: manager.userId,
          dueDate: dateOnly(dueInDays),
        },
      });
    await task('Overdue reply', -3);
    await task('File the appeal', 2);
    await raw.document.create({
      data: {
        officeId,
        fileId,
        name: 'Lease.pdf',
        originalFilename: 'Lease.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 10n,
        checksumSha256: 'b'.repeat(64),
        storageKey: `${officeId}/${fileId}/${randomUUID()}.pdf`,
        status: 'READY',
        uploadedById: manager.userId,
      },
    });
    await raw.client.create({
      data: { officeId, clientType: 'INDIVIDUAL', displayName: 'Nour Haddad' },
    });
    await raw.caseTimelineEvent.create({
      data: {
        officeId,
        fileId,
        eventType: 'FILE_OPENED',
        actorId: manager.userId,
        payload: { fileNumber: fresh.fileNumber },
      },
    });
  }, 60_000);

  afterAll(async () => {
    if (raw) {
      const where = { officeId: { in: officeIds } };
      await raw.caseTimelineEvent.deleteMany({ where });
      await raw.document.deleteMany({ where });
      await raw.task.deleteMany({ where });
      await raw.session.deleteMany({ where });
      await raw.legalFile.deleteMany({ where });
      await raw.client.deleteMany({ where });
      await raw.subscription.deleteMany({ where });
      await raw.officeSettings.deleteMany({ where });
      await raw.user.deleteMany({ where });
      await raw.office.deleteMany({ where: { id: { in: officeIds } } });
    }
    await app?.close();
    process.env = savedEnv;
  });

  const dashboard = async (person: Person) => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/dashboard')
      .set(bearerFor(jwt, person));
    expect(res.status).toBe(200);
    return res.body.data;
  };

  it("should count the lawyer's files, hearings, tasks, documents and activity", async () => {
    const data = await dashboard(lawyer);
    const soonIsToday = wallClock(soon, ZONE).date === wallClock(new Date(), ZONE).date;
    expect(data).toMatchObject({
      today: wallClock(new Date(), ZONE).date,
      openFiles: { count: 2, openedThisWeek: 1 },
      overdueTasks: 1,
      newDocuments: 1,
      newClientsThisMonth: 1,
      team: null,
    });
    expect(data.todayHearings.map((h: { id: string }) => h.id)).toEqual(
      soonIsToday ? [soonId] : [],
    );
    expect(data.nextHearingId).toBe(soonIsToday ? soonId : null);
    // The cancelled hearing is left out; tasks count from their day.
    expect(data.deadlines.map((d: { kind: string }) => d.kind)).toEqual([
      'HEARING',
      'TASK',
      'HEARING',
    ]);
    expect(data.activity.items).toEqual([
      expect.objectContaining({
        eventType: 'FILE_OPENED',
        file: expect.objectContaining({ id: fileId }),
      }),
    ]);
  });

  it("should show the office manager the team's workload but nothing of files they are not on", async () => {
    const data = await dashboard(manager);
    expect(data).toMatchObject({ openFiles: { count: 0 }, newDocuments: 0, overdueTasks: 0 });
    expect(data.activity.items).toEqual([]);
    expect(data.team.hearingsThisWeek).toBe(2);
    expect(data.team.workload).toEqual([
      { userId: manager.userId, fullName: 'Layla Manager', openFiles: 0, overdueTasks: 0 },
      { userId: lawyer.userId, fullName: 'Omar Lawyer', openFiles: 2, overdueTasks: 1 },
    ]);
  });

  it('should leave out client counts and team workload for a trainee, and keep offices apart', async () => {
    expect(await dashboard(trainee)).toMatchObject({
      newClientsThisMonth: null,
      team: null,
      openFiles: { count: 0 },
    });
    const b = await dashboard(other);
    expect(b).toMatchObject({ newClientsThisMonth: 0, team: { hearingsThisWeek: 0 } });
    expect(b.team.workload.map((w: { userId: string }) => w.userId)).toEqual([other.userId]);
  });
});
