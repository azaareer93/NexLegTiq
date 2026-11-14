import { randomUUID } from 'node:crypto';

import { ModuleRef } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { OfficeId, Role } from '@nexlegtiq/shared-types';
import { wallClock } from '@nexlegtiq/shared-utils';
import type { Queue } from 'bullmq';
import type { Job } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';

import { TaskReminders } from './task-reminders';
import { AppModule } from '../../app/app.module';
import { MailService } from '../../common/mail/mail.service';
import { QueueProducer } from '../../common/queue/queue-producer';
import { getQueue, QUEUE } from '../../common/queue/queues';
import { RealtimePublisher } from '../../common/realtime/realtime.publisher';
import { TenantRunner } from '../../common/tenancy/tenant-runner';
import { AppConfig } from '../../config/app-config';
import { integrationEnv } from '../../config/env.fixture';
import { PrismaService } from '../../database/prisma.service';
import { TENANT_MODELS } from '../../database/tenant-models';
import type { PrismaClient } from '../../generated/prisma/client';
import { NotificationService } from '../notifications/notification.service';
import { NotificationProcessor } from '../notifications/workers/notification.processor';
import { liveSubscription } from '../subscriptions/subscription.test-helper';

type Delegate = { deleteMany(args: unknown): Promise<unknown> };
const DAY_MS = 86_400_000;
const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/** MVP-79 on real PostgreSQL and Redis: the 08:00 tick, due-soon reminders, the digest, preferences and idempotency. */
describe('task reminders (PostgreSQL + Redis)', () => {
  let app: NestExpressApplication;
  let raw: PrismaClient;
  let tenant: TenantRunner;
  let reminders: TaskReminders;
  const officeIds: string[] = [];
  const savedEnv = { ...process.env };
  let officeId: string;
  let fileId: string;
  const today = '2026-11-14';
  const queue = (name: (typeof QUEUE)[keyof typeof QUEUE]): Queue => getQueue(app, name);
  const job = (name: (typeof QUEUE)[keyof typeof QUEUE], id: string, office = officeId) =>
    queue(name).getJob(`${office}_${id}`);

  /** A user of the office; a lawyer is put on the file's team so its tasks are theirs to see (unless `team: false`). */
  async function user(role: Role, extra: object = {}, team = true) {
    const id = (
      await raw.user.create({
        data: {
          officeId,
          fullName: `${role} ${randomUUID().slice(0, 4)}`,
          email: `tasks-${randomUUID()}@example.test`,
          passwordHash: '!',
          role,
          ...extra,
        },
      })
    ).id;
    if (team && fileId) await raw.fileTeamMember.create({ data: { officeId, fileId, userId: id } });
    return id;
  }
  const task = (assignedToId: string, dueDate: string | null, extra: object = {}) =>
    raw.task.create({
      data: {
        officeId,
        fileId,
        title: `Task ${randomUUID().slice(0, 4)}`,
        dueDate: dueDate ? new Date(`${dueDate}T00:00:00Z`) : null,
        assignedToId,
        createdById: assignedToId,
        ...extra,
      },
    });
  const daily = () =>
    tenant.run({ officeId: officeId as OfficeId }, () => reminders.daily({ date: today }));

  beforeAll(async () => {
    Object.assign(process.env, integrationEnv());
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication<NestExpressApplication>({ bufferLogs: true });
    await app.init();
    // unscoped: fixtures and checks across offices.
    raw = app.get(PrismaService).unscoped();
    tenant = app.get(TenantRunner);
    reminders = new TaskReminders(
      app.get(PrismaService),
      tenant,
      app.get(QueueProducer),
      app.get(NotificationService, { strict: false }),
      app.get(MailService),
      app.get(AppConfig),
      await app.resolve(PinoLogger),
    );
    const office = await raw.office.create({
      data: {
        name: 'Task reminders office',
        settings: { create: { taskReminderDays: [2] } },
        subscriptions: liveSubscription(),
      },
    });
    officeId = office.id;
    officeIds.push(officeId);
    const owner = await user('OFFICE_MANAGER');
    fileId = (
      await raw.legalFile.create({
        data: {
          officeId,
          fileNumber: `TR-${randomUUID().slice(0, 6)}`,
          title: 'Reminder file',
          fileType: 'LITIGATION',
          responsibleLawyerId: owner,
          jurisdiction: 'PALESTINE',
          currency: 'ILS',
        },
      })
    ).id;
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

  it('should queue the daily job only for offices where it is 08:00, once per local day', async () => {
    const zone = (await raw.office.findUniqueOrThrow({ where: { id: officeId } })).timezone;
    // Find an instant at 08:05 in the office's zone.
    let at = new Date(Date.UTC(2026, 10, 14, 0, 5));
    while (wallClock(at, zone).time !== '08:05') at = new Date(at.getTime() + 3_600_000);
    const date = wallClock(at, zone).date;
    await reminders.tick(new Date(at.getTime() + 3_600_000)); // 09:05: nothing for this office
    await expect(job(QUEUE.REMINDER, `task-daily-${date}`)).resolves.toBeUndefined();
    await reminders.tick(at);
    await reminders.tick(at); // same hour again: the same job id
    const queued = await job(QUEUE.REMINDER, `task-daily-${date}`);
    expect(queued?.name).toBe('task-daily');
    expect(queued?.data).toMatchObject({ date, officeId });
    await queued?.remove();
  });

  it('should remind of tasks due soon, digest overdue and due-today ones by file, and email per preferences', async () => {
    const lawyer = await user('LAWYER', { uiLanguage: 'EN' });
    const quiet = await user('LAWYER', {
      notificationPrefs: { TASKS: { email: false, inApp: true } },
    });
    const soon = await task(lawyer, addDays(today, 2));
    await task(lawyer, addDays(today, -3));
    await task(lawyer, today);
    await task(lawyer, addDays(today, 1)); // neither reminder day nor due: left out
    await task(lawyer, addDays(today, -1), { status: 'DONE', completedAt: new Date() }); // done: left out
    await task(lawyer, null); // no due date: left out
    await task(quiet, today);

    await expect(daily()).resolves.toEqual({ users: 2 });

    const due = await job(QUEUE.NOTIFICATION, `task-due-${soon.id}-${today}`);
    expect(due?.data).toMatchObject({
      type: 'TASK_DUE',
      userIds: [lawyer],
      params: { taskId: soon.id },
    });
    const digest = await job(QUEUE.NOTIFICATION, `task-digest-${lawyer}-${today}`);
    expect(digest?.data).toMatchObject({
      titleKey: 'shell.notifications.taskDigest',
      params: { overdue: 1, today: 1 },
    });
    const email = await job(QUEUE.EMAIL, `task-digest-email-${lawyer}-${today}`);
    expect(email?.data).toMatchObject({
      template: 'task-digest',
      locale: 'EN',
      vars: { count: 3 },
    });
    const files = (email?.data as { vars: { files: { tasks: { overdue: boolean }[] }[] } }).vars
      .files;
    expect(files).toHaveLength(1);
    expect(files[0]?.tasks.filter((t) => t.overdue)).toHaveLength(1);
    // Task emails turned off: the in-app digest still comes, the email does not.
    await expect(job(QUEUE.NOTIFICATION, `task-digest-${quiet}-${today}`)).resolves.toBeDefined();
    await expect(job(QUEUE.EMAIL, `task-digest-email-${quiet}-${today}`)).resolves.toBeUndefined();

    // Run twice the same day: the same job ids, nothing new.
    const before = await queue(QUEUE.NOTIFICATION).getJobCounts();
    await daily();
    const after = await queue(QUEUE.NOTIFICATION).getJobCounts();
    expect(after['waiting'] ?? 0).toBe(before['waiting'] ?? 0);
  });

  it('should send nothing when a user has nothing due, and skip inactive assignees', async () => {
    await raw.task.deleteMany({ where: { officeId } });
    const gone = await user('LAWYER', { isActive: false });
    await task(gone, today);
    await expect(daily()).resolves.toEqual({ users: 0 });
    await expect(job(QUEUE.NOTIFICATION, `task-digest-${gone}-${today}`)).resolves.toBeUndefined();
  });

  it('should write the digest row through the notification worker, honour the in-app switch and keep offices apart', async () => {
    await raw.task.deleteMany({ where: { officeId } });
    const arabic = await user('LAWYER', { uiLanguage: 'AR' });
    const muted = await user('LAWYER', { notificationPrefs: { TASKS: { inApp: false } } });
    await task(arabic, today);
    await task(muted, today);
    // Another office, same day: never part of this office's pass.
    const other = await raw.office.create({
      data: { name: 'Other task office', subscriptions: liveSubscription() },
    });
    officeIds.push(other.id);
    const stranger = (
      await raw.user.create({
        data: {
          officeId: other.id,
          fullName: 'S',
          email: `s-${randomUUID()}@example.test`,
          passwordHash: '!',
          role: 'LAWYER',
        },
      })
    ).id;
    await raw.task.create({
      data: {
        officeId: other.id,
        title: 'Theirs',
        dueDate: new Date(`${today}T00:00:00Z`),
        assignedToId: stranger,
        createdById: stranger,
      },
    });

    await expect(daily()).resolves.toEqual({ users: 2 });
    await expect(
      job(QUEUE.NOTIFICATION, `task-digest-${stranger}-${today}`),
    ).resolves.toBeUndefined();
    await expect(
      job(QUEUE.NOTIFICATION, `task-digest-${stranger}-${today}`, other.id),
    ).resolves.toBeUndefined();
    const email = await job(QUEUE.EMAIL, `task-digest-email-${arabic}-${today}`);
    expect(email?.data).toMatchObject({ locale: 'AR' });

    const worker = new NotificationProcessor(
      tenant,
      app.get(PrismaService),
      await app.resolve(PinoLogger),
      app.get(RealtimePublisher),
      app.get(ModuleRef),
    );
    for (const userId of [arabic, muted]) {
      const queued = (await job(QUEUE.NOTIFICATION, `task-digest-${userId}-${today}`)) as Job;
      await worker.process(queued);
    }
    const rows = await raw.notification.findMany({
      where: { officeId, userId: { in: [arabic, muted] } },
    });
    expect(rows.map((n) => n.userId)).toEqual([arabic]);
    expect(rows[0]).toMatchObject({ type: 'TASK_DUE', titleKey: 'shell.notifications.taskDigest' });
  });

  it('should leave out tasks on files the assignee cannot see, closed, archived or deleted files', async () => {
    await raw.task.deleteMany({ where: { officeId } });
    const outsider = await user('LAWYER', {}, false);
    const member = await user('LAWYER');
    const owner = (await raw.legalFile.findUniqueOrThrow({ where: { id: fileId } }))
      .responsibleLawyerId;
    const fileWith = async (extra: object) =>
      (
        await raw.legalFile.create({
          data: {
            officeId,
            fileNumber: `TR-${randomUUID().slice(0, 6)}`,
            title: 'Other file',
            fileType: 'LITIGATION',
            responsibleLawyerId: owner,
            jurisdiction: 'PALESTINE',
            currency: 'ILS',
            ...extra,
          },
        })
      ).id;
    await task(outsider, today); // a file the outsider is not on
    for (const extra of [
      { status: 'ARCHIVED' },
      { status: 'CLOSED', closingDate: new Date() },
      { deletedAt: new Date() },
    ]) {
      const other = await fileWith(extra);
      await raw.fileTeamMember.create({ data: { officeId, fileId: other, userId: member } });
      await task(member, today, { fileId: other });
    }
    await task(member, today, { fileId: null }); // a task without a file still counts
    await expect(daily()).resolves.toEqual({ users: 1 });
    await expect(
      job(QUEUE.NOTIFICATION, `task-digest-${outsider}-${today}`),
    ).resolves.toBeUndefined();
    const digest = await job(QUEUE.NOTIFICATION, `task-digest-${member}-${today}`);
    expect(digest?.data).toMatchObject({ params: { overdue: 0, today: 1 } });
  });
});
