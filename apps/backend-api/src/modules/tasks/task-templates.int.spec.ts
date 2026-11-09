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
const plus = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);

/** D-156 on real PostgreSQL: the office manager's templates, and the tasks a new file gets from them. */
describe('task templates (HTTP + PostgreSQL)', () => {
  let app: NestExpressApplication;
  let raw: PrismaClient;
  let jwt: JwtService;
  let manager: Person;
  let lawyer: Person;
  let clientId: string;
  const officeIds: string[] = [];
  const savedEnv = { ...process.env };
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    Object.assign(process.env, integrationEnv(), { EMAIL_VERIFICATION_ENFORCED: 'false' });
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = module.createNestApplication<NestExpressApplication>({ bufferLogs: true });
    configureApp(app);
    await app.init();
    // unscoped: fixtures for one office.
    raw = app.get(PrismaService).unscoped();
    jwt = app.get(JwtService);
    const office = await raw.office.create({
      data: {
        name: 'Templates office',
        settings: { create: {} },
        subscriptions: liveSubscription(),
      },
    });
    officeIds.push(office.id);
    const person = async (role: Role): Promise<Person> => {
      const user = await raw.user.create({
        data: {
          officeId: office.id,
          fullName: role,
          email: `tt-${randomUUID()}@example.test`,
          passwordHash: '!',
          role,
        },
      });
      return { userId: user.id, officeId: office.id, role };
    };
    manager = await person('OFFICE_MANAGER');
    lawyer = await person('LAWYER');
    clientId = (
      await raw.client.create({
        data: { officeId: office.id, clientType: 'INDIVIDUAL', displayName: 'Nour' },
      })
    ).id;
  }, 60_000);

  afterAll(async () => {
    if (raw) {
      const where = { officeId: { in: officeIds } };
      await raw.task.deleteMany({ where });
      await raw.taskTemplate.deleteMany({ where });
      await raw.caseTimelineEvent.deleteMany({ where });
      await raw.fileTeamMember.deleteMany({ where });
      await raw.fileClient.deleteMany({ where });
      await raw.legalFile.deleteMany({ where });
      await raw.fileNumberSequence.deleteMany({ where });
      await raw.client.deleteMany({ where });
      await raw.auditLog.deleteMany({ where });
      await raw.subscription.deleteMany({ where });
      await raw.officeSettings.deleteMany({ where });
      await raw.user.deleteMany({ where });
      await raw.office.deleteMany({ where: { id: { in: officeIds } } });
    }
    await app?.close();
    process.env = savedEnv;
  });

  const template = (person: Person, body: object) =>
    http().post('/api/v1/task-templates').set(bearerFor(jwt, person)).send(body);

  it('should let only the office manager manage templates', async () => {
    expect((await template(lawyer, { name: 'x', defaultTitle: 'x' })).status).toBe(403);
    const made = await template(manager, {
      name: 'Any file',
      defaultTitle: 'Open the file folder',
    });
    expect(made.status).toBe(201);
    expect(made.body.data).toMatchObject({
      fileType: null,
      defaultAssigneeRole: 'RESPONSIBLE_LAWYER',
      isActive: true,
    });
    const off = await http()
      .patch(`/api/v1/task-templates/${made.body.data.id}`)
      .set(bearerFor(jwt, manager))
      .send({ isActive: false });
    expect(off.body.data.isActive).toBe(false);
    expect(
      (await template(manager, { name: 'x', defaultTitle: 'x', dueDaysAfterOpen: 400 })).status,
    ).toBe(400);
  });

  it("should turn the matching templates into a new file's tasks, due from its opening day in the office's zone", async () => {
    await template(manager, {
      name: 'Claim',
      fileType: 'LITIGATION',
      defaultTitle: 'Prepare the statement of claim',
      dueDaysAfterOpen: 7,
    });
    // No paralegal on the file: skipped.
    await template(manager, {
      name: 'Evidence',
      fileType: 'LITIGATION',
      defaultTitle: 'File the evidence',
      dueDaysAfterOpen: 14,
      defaultAssigneeRole: 'PARALEGAL',
    });
    await template(manager, {
      name: 'Lease',
      fileType: 'RENTAL_AGREEMENT',
      defaultTitle: 'Draft the lease',
    });
    const created = await http()
      .post('/api/v1/cases')
      .set(bearerFor(jwt, manager))
      .send({
        title: 'Land dispute',
        fileType: 'LITIGATION',
        clientIds: [clientId],
        primaryClientId: clientId,
        responsibleLawyerId: lawyer.userId,
      });
    expect(created.status).toBe(201);
    const tasks = await raw.task.findMany({
      where: { fileId: created.body.data.id },
      orderBy: { sortOrder: 'asc' },
    });
    const opened = wallClock(new Date(), 'Asia/Hebron').date;
    expect(
      tasks.map((t) => [
        t.title,
        t.dueDate?.toISOString().slice(0, 10),
        t.assignedToId,
        t.sourceType,
      ]),
    ).toEqual([['Prepare the statement of claim', plus(opened, 7), lawyer.userId, 'TEMPLATE']]);
  });
});
