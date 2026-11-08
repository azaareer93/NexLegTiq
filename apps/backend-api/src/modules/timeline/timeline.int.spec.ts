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

/** D-150 on real PostgreSQL: a file's timeline through HTTP, paged by cursor, filtered, and only for its readers. */
describe('case timeline (HTTP + PostgreSQL)', () => {
  let app: NestExpressApplication;
  let raw: PrismaClient;
  let jwt: JwtService;
  let manager: Person;
  let lawyer: Person;
  let outsider: Person;
  let other: Person;
  let fileId: string;
  const officeIds: string[] = [];
  const savedEnv = { ...process.env };
  const http = () => request(app.getHttpServer());

  async function office(name: string) {
    const row = await raw.office.create({
      data: { name, settings: { create: {} }, subscriptions: liveSubscription() },
    });
    officeIds.push(row.id);
    return async (role: Role, fullName = role): Promise<Person> => {
      const user = await raw.user.create({
        data: {
          officeId: row.id,
          fullName,
          email: `tl-${randomUUID()}@example.test`,
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
    const inA = await office('Timeline office A');
    manager = await inA('OFFICE_MANAGER', 'Layla Manager');
    lawyer = await inA('LAWYER', 'Omar Lawyer');
    outsider = await inA('LAWYER', 'Sami Elsewhere');
    other = await (await office('Timeline office B'))('OFFICE_MANAGER');
    const file = await raw.legalFile.create({
      data: {
        officeId: manager.officeId,
        fileNumber: `TL-${randomUUID()}`,
        title: 'Rent claim',
        fileType: 'LITIGATION',
        responsibleLawyerId: lawyer.userId,
        jurisdiction: 'PALESTINE',
        currency: 'ILS',
      },
    });
    fileId = file.id;
    const event = (eventType: never, payload: object, minutesAgo: number) =>
      raw.caseTimelineEvent.create({
        data: {
          officeId: manager.officeId,
          fileId,
          eventType,
          actorId: manager.userId,
          payload,
          occurredAt: new Date(Date.now() - minutesAgo * 60_000),
        },
      });
    await event('FILE_OPENED' as never, { fileNumber: file.fileNumber }, 30);
    await event('TEAM_MEMBER_ADDED' as never, { userId: lawyer.userId, role: 'MEMBER' }, 20);
    await event(
      'FILE_REASSIGNED' as never,
      { fromUserId: manager.userId, toUserId: lawyer.userId },
      10,
    );
  }, 60_000);

  afterAll(async () => {
    if (raw) {
      const where = { officeId: { in: officeIds } };
      await raw.caseTimelineEvent.deleteMany({ where });
      await raw.legalFile.deleteMany({ where });
      await raw.subscription.deleteMany({ where });
      await raw.officeSettings.deleteMany({ where });
      await raw.user.deleteMany({ where });
      await raw.office.deleteMany({ where: { id: { in: officeIds } } });
    }
    await app?.close();
    process.env = savedEnv;
  });

  const timeline = (person: Person, query = '') =>
    http().get(`/api/v1/cases/${fileId}/timeline${query}`).set(bearerFor(jwt, person));

  it('should page the history newest first by cursor, with the names it mentions', async () => {
    const first = await timeline(manager, '?limit=2');
    expect(first.status).toBe(200);
    expect(first.body.data.items.map((e: { eventType: string }) => e.eventType)).toEqual([
      'FILE_REASSIGNED',
      'TEAM_MEMBER_ADDED',
    ]);
    expect(first.body.data.items[0]).toMatchObject({
      actor: { id: manager.userId, fullName: 'Layla Manager' },
      portalVisible: false,
    });
    expect(first.body.data.names).toEqual({
      [manager.userId]: 'Layla Manager',
      [lawyer.userId]: 'Omar Lawyer',
    });
    const second = await timeline(manager, `?limit=2&cursor=${first.body.data.nextCursor}`);
    expect(second.body.data.items.map((e: { eventType: string }) => e.eventType)).toEqual([
      'FILE_OPENED',
    ]);
    expect(second.body.data).toMatchObject({ nextCursor: null });
    expect(second.body.data.items[0].portalVisible).toBe(true);
  });

  it('should filter by type and refuse an unknown one', async () => {
    const filtered = await timeline(lawyer, '?types=FILE_OPENED,FILE_REASSIGNED');
    expect(filtered.body.data.items).toHaveLength(2);
    expect((await timeline(manager, '?types=NOT_A_TYPE')).status).toBe(400);
  });

  it('should answer 404 to a colleague who cannot see the file and to another office', async () => {
    for (const person of [outsider, other]) {
      const refused = await timeline(person);
      expect([refused.status, refused.body.error.code]).toEqual([404, 'RES-001']);
    }
    const malformed = await http().get('/api/v1/cases/x/timeline').set(bearerFor(jwt, manager));
    expect(malformed.status).toBe(404);
  });
});
