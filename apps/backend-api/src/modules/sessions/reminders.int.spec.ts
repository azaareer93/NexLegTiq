import { randomUUID } from 'node:crypto';

import { JwtService } from '@nestjs/jwt';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { OfficeId, Role } from '@nexlegtiq/shared-types';
import type { Queue } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import request from 'supertest';

import { ReminderDelivery } from './reminder-delivery';
import { ReminderScheduler } from './reminder-scheduler';
import { zonedInstant } from './session-rules';
import { ReminderProcessor } from './workers/reminder.processor';
import { AppModule } from '../../app/app.module';
import { configureApp } from '../../app/configure-app';
import { MailService } from '../../common/mail/mail.service';
import { QueueProducer } from '../../common/queue/queue-producer';
import { getQueue, QUEUE } from '../../common/queue/queues';
import { TenantRunner } from '../../common/tenancy/tenant-runner';
import { AppConfig } from '../../config/app-config';
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
type SessionBody = { id: string; reminders: { id: string; recipient: { id: string } }[] };

const DAY_MS = 86_400_000;
const TODAY = Date.UTC(
  new Date().getUTCFullYear(),
  new Date().getUTCMonth(),
  new Date().getUTCDate(),
);
let nextDay = 40;
/** 08:00 UTC (10:00 or 11:00 in Hebron) on a fresh day, so tests never conflict. */
const freshStart = () => new Date(TODAY + nextDay++ * DAY_MS + 8 * 3_600_000).toISOString();
/** 09:00 Hebron time `days` calendar days before the date of `startsAt` (10:00/11:00 local: same date as UTC). */
const nineAm = (startsAt: string, days: number) => {
  const date = new Date(startsAt);
  return zonedInstant(
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate() - days,
    9,
    'Asia/Hebron',
  );
};

/** MVP-68 on real PostgreSQL and Redis: reminder rows, delayed jobs, reconciliation, delivery and acknowledgement. */
describe('hearing reminders (HTTP + PostgreSQL + Redis)', () => {
  let app: NestExpressApplication;
  let raw: PrismaClient;
  let jwt: JwtService;
  let tenant: TenantRunner;
  let delivery: ReminderDelivery;
  let processor: ReminderProcessor;
  const officeIds: string[] = [];
  const savedEnv = { ...process.env };
  const users: Record<string, SeededUser> = {};
  let officeId: string;
  let fileId: string;
  let otherOffice: SeededUser;

  const http = () => request(app.getHttpServer());
  const user = (key: string) => users[key] as SeededUser;
  const as = (key: string) => bearerFor(jwt, user(key));
  const queue = (name: (typeof QUEUE)[keyof typeof QUEUE]): Queue => getQueue(app, name);
  const job = (name: (typeof QUEUE)[keyof typeof QUEUE], id: string, office = officeId) =>
    queue(name).getJob(`${office}_${id}`);
  const inOffice = <T>(work: () => Promise<T>) =>
    tenant.run({ officeId: officeId as OfficeId }, work);

  async function seedUser(office: string, role: Role, extra: object = {}): Promise<SeededUser> {
    const created = await raw.user.create({
      data: {
        officeId: office,
        fullName: `${role} ${randomUUID().slice(0, 4)}`,
        email: `reminders-${randomUUID()}@example.test`,
        passwordHash: '!',
        role,
        ...extra,
      },
    });
    return { userId: created.id, officeId: office, role };
  }

  async function seedOffice(name: string): Promise<string> {
    const office = await raw.office.create({ data: { name, settings: { create: {} } } });
    officeIds.push(office.id);
    return office.id;
  }

  async function schedule(body: Record<string, unknown>): Promise<SessionBody> {
    const res = await http()
      .post('/api/v1/sessions')
      .set(as('responsible'))
      .send({ fileId, attendingLawyerId: user('attending').userId, ...body });
    expect(res.status).toBe(201);
    return (res.body as { data: SessionBody }).data;
  }

  const rows = (sessionId: string) =>
    raw.sessionReminder.findMany({
      where: { sessionId },
      orderBy: [{ scheduledFor: 'asc' }, { recipientId: 'asc' }],
    });

  beforeAll(async () => {
    Object.assign(process.env, integrationEnv(), {
      EMAIL_VERIFICATION_ENFORCED: 'false',
      BULLMQ_PREFIX: `test-rem-${randomUUID().slice(0, 8)}`,
    });
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = module.createNestApplication<NestExpressApplication>({ bufferLogs: true });
    configureApp(app);
    await app.init();
    // unscoped: test fixtures create offices, users and files and read rows across offices.
    raw = app.get(PrismaService).unscoped();
    jwt = app.get(JwtService);
    tenant = app.get(TenantRunner);
    // The worker's providers, built on the HTTP app's services (no worker consumes in this test: jobs stay queued).
    const prisma = app.get(PrismaService);
    const scheduler = app.get(ReminderScheduler, { strict: false });
    delivery = new ReminderDelivery(
      prisma,
      app.get(MailService),
      app.get(QueueProducer),
      app.get(AppConfig),
    );
    processor = new ReminderProcessor(
      tenant,
      prisma,
      await app.resolve(PinoLogger),
      delivery,
      scheduler,
      app as never,
    );

    officeId = await seedOffice('Reminders office');
    users['responsible'] = await seedUser(officeId, 'LAWYER', { uiLanguage: 'EN' });
    users['attending'] = await seedUser(officeId, 'LAWYER');
    users['colleague'] = await seedUser(officeId, 'OFFICE_MANAGER');
    const file = await raw.legalFile.create({
      data: {
        officeId,
        fileNumber: `R-${randomUUID().slice(0, 8)}`,
        title: 'Reminders test file',
        fileType: 'LITIGATION',
        responsibleLawyerId: user('responsible').userId,
        jurisdiction: 'PALESTINE',
        currency: 'ILS',
      },
    });
    fileId = file.id;
    for (const key of ['responsible', 'attending']) {
      await raw.fileTeamMember.create({
        data: { officeId, fileId, userId: user(key).userId },
      });
    }
    otherOffice = await seedUser(await seedOffice('Other reminders office'), 'OFFICE_MANAGER');
  }, 60_000);

  afterAll(async () => {
    if (app) {
      for (const name of [QUEUE.REMINDER, QUEUE.EMAIL, QUEUE.NOTIFICATION]) {
        await queue(name).obliterate({ force: true });
      }
    }
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

  it('should write a reminder per day and recipient at 09:00 office time, each a delayed job', async () => {
    const startsAt = freshStart();
    const created = await schedule({ startsAt });
    const reminders = await rows(created.id);
    expect(reminders).toHaveLength(6);
    const expected = [7, 3, 1].flatMap((days) =>
      [user('responsible').userId, user('attending').userId]
        .sort()
        .map((recipientId) => ({ days, recipientId })),
    );
    expect(
      reminders.map((row) => ({ days: row.daysBefore, recipientId: row.recipientId })),
    ).toEqual(expected);
    for (const row of reminders) {
      expect(row.scheduledFor).toEqual(nineAm(startsAt, row.daysBefore));
      expect(row.status).toBe('PENDING');
      expect(row.jobId).toBe(`reminder-${row.id}`);
      const queued = await job(QUEUE.REMINDER, `reminder-${row.id}`);
      expect(await queued?.getState()).toBe('delayed');
      expect(queued?.data).toMatchObject({ reminderId: row.id, officeId });
    }
    // The session drawer: reminders with their recipient and state.
    const res = await http().get(`/api/v1/sessions/${created.id}`).set(as('attending')).expect(200);
    expect((res.body as { data: SessionBody }).data.reminders).toHaveLength(6);
  });

  it('should replace the jobs on a reschedule and remove them on cancel', async () => {
    const created = await schedule({ startsAt: freshStart(), reminderDays: [2] });
    const before = await rows(created.id);
    await http()
      .patch(`/api/v1/sessions/${created.id}`)
      .set(as('responsible'))
      .send({ startsAt: freshStart() })
      .expect(200);
    for (const row of before) expect(await job(QUEUE.REMINDER, `reminder-${row.id}`)).toBeFalsy();
    const pending = (await rows(created.id)).filter((row) => row.status === 'PENDING');
    expect(pending).toHaveLength(2);
    for (const row of pending) expect(await job(QUEUE.REMINDER, `reminder-${row.id}`)).toBeTruthy();

    await http()
      .post(`/api/v1/sessions/${created.id}/cancel`)
      .set(as('responsible'))
      .send({})
      .expect(200);
    const after = await rows(created.id);
    expect(after.every((row) => row.status === 'CANCELLED')).toBe(true);
    for (const row of after) expect(await job(QUEUE.REMINDER, `reminder-${row.id}`)).toBeFalsy();
  });

  it('should restore a job lost from Redis in the daily reconciliation', async () => {
    const created = await schedule({ startsAt: freshStart(), reminderDays: [1] });
    const [lost, kept] = await rows(created.id);
    await queue(QUEUE.REMINDER).remove(`${officeId}_reminder-${lost?.id}`);
    const keptJob = await job(QUEUE.REMINDER, `reminder-${kept?.id}`);

    const result = await processor.reconcile();
    expect(result.pending).toBeGreaterThanOrEqual(2);
    const restored = await job(QUEUE.REMINDER, `reminder-${lost?.id}`);
    expect(await restored?.getState()).toBe('delayed');
    expect(restored?.data).toMatchObject({ reminderId: lost?.id, officeId });
    // A job still in Redis is left as it was.
    expect((await job(QUEUE.REMINDER, `reminder-${kept?.id}`))?.timestamp).toBe(keptJob?.timestamp);
  });

  it('should send a reminder due now once: email and in-app notification, then SENT', async () => {
    // Tomorrow: the 3-day reminder is already past, so it is due at once.
    const created = await schedule({
      startsAt: new Date(TODAY + DAY_MS + 12 * 3_600_000).toISOString(),
      reminderDays: [3],
    });
    const reminder = (await rows(created.id)).find(
      (row) => row.recipientId === user('responsible').userId,
    );
    expect(reminder?.scheduledFor.getTime()).toBeLessThanOrEqual(Date.now());
    expect(await inOffice(() => delivery.deliver(reminder?.id ?? ''))).toEqual({
      sent: user('responsible').userId,
    });
    const email = await job(QUEUE.EMAIL, `reminder-${reminder?.id}-email`);
    expect(email?.data).toMatchObject({ template: 'hearing-reminder', locale: 'EN' });
    const notification = await job(QUEUE.NOTIFICATION, `reminder-${reminder?.id}-notification`);
    expect(notification?.data).toMatchObject({
      userId: user('responsible').userId,
      titleKey: 'shell.notifications.hearingReminder',
    });
    expect(await raw.sessionReminder.findUnique({ where: { id: reminder?.id } })).toMatchObject({
      status: 'SENT',
      sentAt: expect.any(Date),
    });

    const emails = await queue(QUEUE.EMAIL).count();
    expect(await inOffice(() => delivery.deliver(reminder?.id ?? ''))).toEqual({
      skipped: 'NOT_PENDING',
    });
    expect(await queue(QUEUE.EMAIL).count()).toBe(emails);
  });

  describe('POST /sessions/reminders/:id/ack', () => {
    it('should let the recipient acknowledge, once, and hide the reminder from anyone else', async () => {
      const created = await schedule({ startsAt: freshStart(), reminderDays: [1] });
      const mine = (await rows(created.id)).find(
        (row) => row.recipientId === user('attending').userId,
      );
      const ack = (key: string, id = mine?.id ?? '') =>
        http().post(`/api/v1/sessions/reminders/${id}/ack`).set(as(key));

      const first = await ack('attending').expect(200);
      const body = (first.body as { data: { id: string; acknowledgedAt: string } }).data;
      expect(body).toMatchObject({ id: mine?.id, recipient: { id: user('attending').userId } });
      expect(body.acknowledgedAt).toEqual(expect.any(String));
      const again = await ack('attending').expect(200);
      expect((again.body as { data: { acknowledgedAt: string } }).data.acknowledgedAt).toBe(
        body.acknowledgedAt,
      );

      // Another user of the office (even the manager), another office, an unknown or malformed id: 404.
      await ack('colleague').expect(404);
      users['outsider'] = otherOffice;
      await ack('outsider').expect(404);
      await ack('attending', randomUUID()).expect(404);
      await ack('attending', 'not-a-uuid').expect(404);
    });
  });
});
