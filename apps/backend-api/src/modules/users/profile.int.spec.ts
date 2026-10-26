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
import { jpegHeader, pngHeader } from '../documents/extraction/fixtures.test-helper';
import { liveSubscription } from '../subscriptions/subscription.test-helper';

/** `users/me` and `notifications/preferences` (D-146) through HTTP on real PostgreSQL and storage. */
describe('profile and notification preferences (HTTP + PostgreSQL)', () => {
  let app: NestExpressApplication;
  let raw: PrismaClient;
  let jwt: JwtService;
  const officeIds: string[] = [];
  const savedEnv = { ...process.env };
  const http = () => request(app.getHttpServer());

  async function seed(role: Role = 'LAWYER', officeId?: string) {
    const office =
      officeId ??
      (
        await raw.office.create({
          data: {
            name: 'Profile office',
            settings: { create: {} },
            subscriptions: liveSubscription(),
          },
        })
      ).id;
    if (!officeId) officeIds.push(office);
    const user = await raw.user.create({
      data: {
        officeId: office,
        fullName: 'Rana Lawyer',
        email: `profile-${randomUUID()}@example.test`,
        passwordHash: '!',
        role,
      },
    });
    return { userId: user.id, officeId: office, role };
  }
  const as = (user: Awaited<ReturnType<typeof seed>>) => bearerFor(jwt, user);

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
  }, 60_000);

  afterAll(async () => {
    if (raw) {
      const where = { officeId: { in: officeIds } };
      await raw.notification.deleteMany({ where });
      await raw.task.deleteMany({ where });
      await raw.auditLog.deleteMany({ where });
      await raw.subscription.deleteMany({ where });
      await raw.officeSettings.deleteMany({ where });
      await raw.user.deleteMany({ where });
      await raw.office.deleteMany({ where: { id: { in: officeIds } } });
    }
    await app?.close();
    process.env = savedEnv;
  });

  it('should show and change only the fields sent, audited, and refuse bad values', async () => {
    const me = await seed();
    const shown = await http().get('/api/v1/users/me').set(as(me)).expect(200);
    expect(shown.body.data).toMatchObject({
      id: me.userId,
      fullName: 'Rana Lawyer',
      uiLanguage: 'AR',
      timezone: null,
      digitStyle: 'WESTERN',
      avatar: null,
    });
    const changed = await http()
      .patch('/api/v1/users/me')
      .set(as(me))
      .send({
        uiLanguage: 'EN',
        digitStyle: 'ARABIC_INDIC',
        timezone: 'asia/amman',
        phone: '+970599123456',
      })
      .expect(200);
    expect(changed.body.data).toMatchObject({
      uiLanguage: 'EN',
      digitStyle: 'ARABIC_INDIC',
      timezone: 'Asia/Amman',
      phone: '+970599123456',
    });
    const audit = await raw.auditLog.findFirstOrThrow({
      where: { entityId: me.userId, action: 'UPDATE' },
      orderBy: { id: 'desc' }, // UUID v7: time-ordered
    });
    expect(audit.newValues).toMatchObject({ uiLanguage: 'EN', digitStyle: 'ARABIC_INDIC' });
    expect(audit.oldValues).toMatchObject({ uiLanguage: 'AR', digitStyle: 'WESTERN' });
    await http().patch('/api/v1/users/me').set(as(me)).send({ timezone: 'Mars/Base' }).expect(400);
    await http().patch('/api/v1/users/me').set(as(me)).send({}).expect(400);
    await http().patch('/api/v1/users/me').set(as(me)).send({ fullName: 'R' }).expect(400);
    await http().get('/api/v1/users/me').expect(401);
  });

  it('should take a PNG or JPEG avatar up to 2 MB and 2048 px, replace and remove it', async () => {
    const me = await seed();
    const upload = (content: Buffer, name: string) =>
      http().post('/api/v1/users/me/avatar').set(as(me)).attach('file', content, name);
    const png = Buffer.concat([pngHeader(256, 256), Buffer.alloc(200)]);
    const first = await upload(png, 'me.png').expect(201);
    expect(first.body.data.avatar.url).toContain(`${me.officeId}/users/${me.userId}/avatar-`);
    const firstKey = (await raw.user.findUniqueOrThrow({ where: { id: me.userId } })).avatarUrl;
    await upload(Buffer.concat([jpegHeader(512, 512), Buffer.alloc(200)]), 'me.jpg').expect(201);
    const secondKey = (await raw.user.findUniqueOrThrow({ where: { id: me.userId } })).avatarUrl;
    expect(secondKey).not.toBe(firstKey);
    expect((await upload(Buffer.from('%PDF-1.7 fake'), 'me.pdf').expect(415)).body.error.code).toBe(
      'VAL-005',
    );
    expect(
      (
        await upload(Buffer.concat([pngHeader(4096, 4096), Buffer.alloc(200)]), 'big.png').expect(
          400,
        )
      ).body.error.details[0].message,
    ).toBe('validation.avatarSize');
    expect(
      (
        await upload(
          Buffer.concat([pngHeader(64, 64), Buffer.alloc(2 * 1024 * 1024)]),
          'heavy.png',
        ).expect(413)
      ).body.error.code,
    ).toBe('VAL-006');
    const removed = await http().delete('/api/v1/users/me/avatar').set(as(me)).expect(200);
    expect(removed.body.data.avatar).toBeNull();
  });

  it('should keep channels on unless turned off, and skip an in-app notification turned off', async () => {
    const lawyer = await seed('LAWYER');
    const prefs = await http().get('/api/v1/notifications/preferences').set(as(lawyer)).expect(200);
    expect(prefs.body.data).toContainEqual({ category: 'HEARINGS', inApp: true, email: true });
    expect(prefs.body.data).toContainEqual({ category: 'TASKS', inApp: true, email: null });
    const updated = await http()
      .patch('/api/v1/notifications/preferences')
      .set(as(lawyer))
      .send({ TASKS: { inApp: false, email: false }, HEARINGS: { email: false } })
      .expect(200);
    expect(updated.body.data).toContainEqual({ category: 'TASKS', inApp: false, email: null });
    expect(updated.body.data).toContainEqual({ category: 'HEARINGS', inApp: true, email: false });
    await http()
      .patch('/api/v1/notifications/preferences')
      .set(as(lawyer))
      .send({ NOPE: {} })
      .expect(400);

    // A manager gives the lawyer a task: the board still updates, but no notification is written.
    const manager = await seed('OFFICE_MANAGER', lawyer.officeId);
    await http()
      .post('/api/v1/tasks')
      .set(as(manager))
      .send({ title: 'Draft the appeal', assignedToId: lawyer.userId })
      .expect(201);
    expect(await raw.notification.count({ where: { userId: lawyer.userId } })).toBe(0);
    // Turned back on: the next assignment notifies.
    await http()
      .patch('/api/v1/notifications/preferences')
      .set(as(lawyer))
      .send({ TASKS: { inApp: true } })
      .expect(200);
    await http()
      .post('/api/v1/tasks')
      .set(as(manager))
      .send({ title: 'File the appeal', assignedToId: lawyer.userId })
      .expect(201);
    expect(
      await raw.notification.count({ where: { userId: lawyer.userId, type: 'task.assigned' } }),
    ).toBe(1);
  });
});
