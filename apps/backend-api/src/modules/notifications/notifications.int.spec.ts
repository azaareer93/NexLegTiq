import { randomUUID } from 'node:crypto';

import { ModuleRef } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Role } from '@nexlegtiq/shared-types';
import type { Job } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import request from 'supertest';

import { NotificationProcessor } from './workers/notification.processor';
import { AppModule } from '../../app/app.module';
import { configureApp } from '../../app/configure-app';
import { RealtimePublisher } from '../../common/realtime/realtime.publisher';
import { TenantRunner } from '../../common/tenancy/tenant-runner';
import { integrationEnv } from '../../config/env.fixture';
import { PrismaService } from '../../database/prisma.service';
import type { PrismaClient } from '../../generated/prisma/client';
import { bearerFor } from '../auth/auth.test-helper';
import { liveSubscription } from '../subscriptions/subscription.test-helper';

type Person = { userId: string; officeId: string; role: Role };

/** D-149 on real PostgreSQL: the fan-out worker, preferences, and the caller's own notification routes. */
describe('notifications (HTTP + PostgreSQL)', () => {
  let app: NestExpressApplication;
  let raw: PrismaClient;
  let jwt: JwtService;
  let processor: NotificationProcessor;
  let a1: Person;
  let a2: Person;
  let b1: Person;
  const officeIds: string[] = [];
  const savedEnv = { ...process.env };
  const http = () => request(app.getHttpServer());

  async function seed(name: string): Promise<[Person, Person]> {
    const office = await raw.office.create({
      data: { name, settings: { create: {} }, subscriptions: liveSubscription() },
    });
    officeIds.push(office.id);
    const person = async (prefs: object = {}): Promise<Person> => {
      const user = await raw.user.create({
        data: {
          officeId: office.id,
          fullName: 'Notified user',
          email: `notif-${randomUUID()}@example.test`,
          passwordHash: '!',
          role: 'LAWYER',
          notificationPrefs: prefs,
        },
      });
      return { userId: user.id, officeId: office.id, role: 'LAWYER' };
    };
    return [await person(), await person({ DOCUMENTS: { inApp: false } })];
  }

  const fanOut = (person: Person, userIds: string[], type = 'DOCUMENT_PROCESSED') =>
    processor.process({
      id: randomUUID(),
      name: 'fan-out-notification',
      queueName: 'notification',
      attemptsMade: 0,
      opts: { attempts: 3 },
      data: {
        officeId: person.officeId,
        requestId: null,
        userIds,
        type,
        titleKey: 'shell.notifications.documentProcessed',
        params: { name: 'claim.pdf' },
        link: '/cases/x?tab=documents',
      },
    } as unknown as Job<never>);

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
    processor = new NotificationProcessor(
      app.get(TenantRunner),
      app.get(PrismaService),
      await app.resolve(PinoLogger),
      app.get(RealtimePublisher),
      app.get(ModuleRef),
    );
    [a1, a2] = await seed('Notifications office A');
    [b1] = await seed('Notifications office B');
  }, 60_000);

  afterAll(async () => {
    if (raw) {
      const where = { officeId: { in: officeIds } };
      await raw.notification.deleteMany({ where });
      await raw.subscription.deleteMany({ where });
      await raw.officeSettings.deleteMany({ where });
      await raw.user.deleteMany({ where });
      await raw.office.deleteMany({ where: { id: { in: officeIds } } });
    }
    await app?.close();
    process.env = savedEnv;
  });

  it('should write rows only for recipients who want the type, in the job office', async () => {
    await expect(fanOut(a1, [a1.userId, a2.userId])).resolves.toEqual({ created: 1 });
    await expect(raw.notification.count({ where: { userId: a2.userId } })).resolves.toBe(0);
    // A malware alert cannot be muted (D-146).
    await expect(fanOut(a1, [a2.userId], 'DOCUMENT_QUARANTINED')).resolves.toEqual({
      created: 1,
    });
    // A user of another office cannot be named (composite foreign key).
    await expect(fanOut(b1, [a1.userId])).rejects.toThrow();
  });

  it('should page the own notifications by cursor and count the unread ones', async () => {
    for (let i = 0; i < 4; i++) await fanOut(a1, [a1.userId]);
    await fanOut(b1, [b1.userId]);
    const first = await http().get('/api/v1/notifications?limit=3').set(bearerFor(jwt, a1));
    expect(first.status).toBe(200);
    expect(first.body.data.items).toHaveLength(3);
    const second = await http()
      .get(`/api/v1/notifications?limit=3&cursor=${first.body.data.nextCursor}`)
      .set(bearerFor(jwt, a1));
    // 1 from the first test + 4 here = 5: three, then two, then no further page.
    expect(second.body.data.items).toHaveLength(2);
    expect(second.body.data.nextCursor).toBeNull();
    const ids = [...first.body.data.items, ...second.body.data.items].map(
      (n: { id: string }) => n.id,
    );
    expect([...ids].sort().reverse()).toEqual(ids);
    const count = await http().get('/api/v1/notifications/unread-count').set(bearerFor(jwt, a1));
    expect(count.body.data).toEqual({ count: 5 });
    const other = await http().get('/api/v1/notifications/unread-count').set(bearerFor(jwt, b1));
    expect(other.body.data).toEqual({ count: 1 });
  });

  it('should mark one or all read, and never those of someone else', async () => {
    const list = await http().get('/api/v1/notifications?limit=1').set(bearerFor(jwt, a1));
    const mine = (list.body.data.items as { id: string }[])[0]?.id;
    const read = await http().post(`/api/v1/notifications/${mine}/read`).set(bearerFor(jwt, a1));
    expect(read.status).toBe(200);
    expect(read.body.data.readAt).not.toBeNull();
    const again = await http().post(`/api/v1/notifications/${mine}/read`).set(bearerFor(jwt, a1));
    expect(again.body.data.readAt).toBe(read.body.data.readAt);
    const unread = await http().get('/api/v1/notifications?unread=true').set(bearerFor(jwt, a1));
    expect(unread.body.data.items.map((n: { id: string }) => n.id)).not.toContain(mine);
    for (const someone of [a2, b1]) {
      const refused = await http()
        .post(`/api/v1/notifications/${mine}/read`)
        .set(bearerFor(jwt, someone));
      expect([refused.status, refused.body.error.code]).toEqual([404, 'RES-001']);
    }
    const malformed = await http().post('/api/v1/notifications/x/read').set(bearerFor(jwt, a1));
    expect(malformed.status).toBe(404);
    const all = await http().post('/api/v1/notifications/read-all').set(bearerFor(jwt, a1));
    expect(all.body.data).toEqual({ count: 4 });
    await expect(
      raw.notification.count({ where: { userId: b1.userId, readAt: null } }),
    ).resolves.toBe(1);
  });

  it('should purge notifications older than 90 days in every office', async () => {
    const old = await raw.notification.create({
      data: {
        officeId: b1.officeId,
        userId: b1.userId,
        type: 'TASK_ASSIGNED',
        titleKey: 'common.notifications.taskAssigned',
        createdAt: new Date(Date.now() - 91 * 86_400_000),
      },
    });
    const before = await raw.notification.count({ where: { officeId: { in: officeIds } } });
    const { removed } = await processor.purge();
    expect(removed).toBeGreaterThanOrEqual(1);
    await expect(raw.notification.findUnique({ where: { id: old.id } })).resolves.toBeNull();
    await expect(raw.notification.count({ where: { officeId: { in: officeIds } } })).resolves.toBe(
      before - 1,
    );
  });
});
