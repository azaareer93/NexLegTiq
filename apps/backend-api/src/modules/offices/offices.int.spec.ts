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
import { TENANT_MODELS } from '../../database/tenant-models';
import type { PrismaClient } from '../../generated/prisma/client';
import { bearerFor } from '../auth/auth.test-helper';
import { liveSubscription } from '../subscriptions/subscription.test-helper';

type Delegate = { deleteMany(args: unknown): Promise<unknown> };
interface SeededUser {
  readonly userId: string;
  readonly officeId: string;
  readonly role: Role;
}
type ErrorBody = { error: { code: string; details?: { field: string; message: string }[] } };

/** MVP-48 through HTTP on real PostgreSQL: office profile and settings, validation, audit and their effect (D-125). */
describe('office profile and settings (HTTP + PostgreSQL)', () => {
  let app: NestExpressApplication;
  let raw: PrismaClient;
  let jwt: JwtService;
  let manager: SeededUser;
  let other: SeededUser;
  const officeIds: string[] = [];
  const savedEnv = { ...process.env };

  const http = () => request(app.getHttpServer());
  const as = (user: SeededUser) => bearerFor(jwt, user);
  const fieldsOf = (body: unknown) =>
    ((body as ErrorBody).error.details ?? []).map((d) => `${d.field}: ${d.message}`);

  async function seedUser(officeId: string, role: Role = 'OFFICE_MANAGER'): Promise<SeededUser> {
    const user = await raw.user.create({
      data: {
        officeId,
        fullName: `${role} ${randomUUID().slice(0, 4)}`,
        email: `offices-${randomUUID()}@example.test`,
        passwordHash: '!',
        role,
      },
    });
    return { userId: user.id, officeId, role };
  }

  async function seedOffice(name: string): Promise<SeededUser> {
    const office = await raw.office.create({
      data: { name, settings: { create: {} }, subscriptions: liveSubscription() },
    });
    officeIds.push(office.id);
    return seedUser(office.id);
  }

  const auditRows = (user: SeededUser, entityType: string) =>
    raw.auditLog.findMany({
      where: { officeId: user.officeId, entityType },
      orderBy: { occurredAt: 'asc' },
    });

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
    manager = await seedOffice('Offices office');
    other = await seedOffice('Other office');
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

  it('should return the office profile and settings to the office manager', async () => {
    const profile = await http().get('/api/v1/offices/me').set(as(manager)).expect(200);
    expect(profile.body.data).toMatchObject({
      id: manager.officeId,
      name: 'Offices office',
      jurisdiction: 'PALESTINE',
      currency: 'ILS',
      timezone: 'Asia/Hebron',
      website: null,
    });
    const settings = await http().get('/api/v1/offices/me/settings').set(as(manager)).expect(200);
    expect(settings.body.data).toEqual({
      courtReminderDays: [7, 3, 1],
      taskReminderDays: [1],
      defaultBillingRate: null,
      defaultBillingMethod: 'HOURLY',
      taxRatePercent: '0.00',
      enableAi: true,
      enableOcr: true,
      fileNumberFormat: '{YEAR}-{TYPE}-{SEQ:5}',
      sessionIdleMinutes: 30,
      auditRetentionDays: 365,
    });
  });

  it('should refuse every route to a role without manage:office (403 AUTH-100)', async () => {
    const lawyer = await seedUser(manager.officeId, 'SENIOR_LAWYER');
    for (const [method, path] of [
      ['get', '/api/v1/offices/me'],
      ['patch', '/api/v1/offices/me'],
      ['get', '/api/v1/offices/me/settings'],
      ['patch', '/api/v1/offices/me/settings'],
    ] as const) {
      const res = await http()
        [method](path)
        .set(as(lawyer))
        .send({ name: 'Taken over' })
        .expect(403);
      expect((res.body as ErrorBody).error.code).toBe('AUTH-100');
    }
  });

  it('should update only the profile fields that changed, audit them, and leave other offices alone', async () => {
    const res = await http()
      .patch('/api/v1/offices/me')
      .set(as(manager))
      .send({
        name: 'Offices office',
        website: 'https://office.example.test',
        email: ' Info@Office.Example.TEST ',
        currency: 'jod',
        timezone: 'Asia/Amman',
        jurisdiction: 'JORDAN',
      })
      .expect(200);
    expect(res.body.data).toMatchObject({
      name: 'Offices office',
      website: 'https://office.example.test',
      email: 'info@office.example.test',
      currency: 'JOD',
      timezone: 'Asia/Amman',
      jurisdiction: 'JORDAN',
    });
    const [row] = await auditRows(manager, 'Office');
    expect(row).toMatchObject({
      entityId: manager.officeId,
      action: 'UPDATE',
      userId: manager.userId,
    });
    expect(row?.oldValues).toEqual({
      website: null,
      email: null,
      currency: 'ILS',
      timezone: 'Asia/Hebron',
      jurisdiction: 'PALESTINE',
    });

    // '' clears an optional field; sending the same values again writes nothing.
    await http().patch('/api/v1/offices/me').set(as(manager)).send({ website: '' }).expect(200);
    await http().patch('/api/v1/offices/me').set(as(manager)).send({ website: null }).expect(200);
    expect(await auditRows(manager, 'Office')).toHaveLength(2);

    const untouched = await http().get('/api/v1/offices/me').set(as(other)).expect(200);
    expect(untouched.body.data).toMatchObject({ name: 'Other office', currency: 'ILS' });
  });

  it('should refuse an invalid profile with the field in error', async () => {
    const res = await http()
      .patch('/api/v1/offices/me')
      .set(as(manager))
      .send({ timezone: 'Mars/Olympus', currency: 'XYZ', website: 'javascript:alert(1)', name: '' })
      .expect(400);
    expect(fieldsOf(res.body).sort()).toEqual([
      'currency: validation.currency',
      'name: validation.required',
      'timezone: validation.timeZone',
      'website: validation.website',
    ]);
  });

  it('should save settings with reminder days sorted and money as decimals, auditing old and new values', async () => {
    const res = await http()
      .patch('/api/v1/offices/me/settings')
      .set(as(manager))
      .send({
        courtReminderDays: [1, 14, 3],
        taskReminderDays: [],
        defaultBillingRate: '150',
        taxRatePercent: '16',
        enableAi: false,
        sessionIdleMinutes: 60,
        auditRetentionDays: 730,
      })
      .expect(200);
    expect(res.body.data).toMatchObject({
      courtReminderDays: [14, 3, 1],
      taskReminderDays: [],
      defaultBillingRate: '150.00',
      taxRatePercent: '16.00',
      enableAi: false,
      sessionIdleMinutes: 60,
      auditRetentionDays: 730,
    });
    const [row] = await auditRows(manager, 'OfficeSettings');
    expect(row?.oldValues).toEqual({
      courtReminderDays: [7, 3, 1],
      taskReminderDays: [1],
      defaultBillingRate: null,
      taxRatePercent: '0.00',
      enableAi: true,
      sessionIdleMinutes: 30,
      auditRetentionDays: 365,
    });
    // The same amount written differently is no change.
    await http()
      .patch('/api/v1/offices/me/settings')
      .set(as(manager))
      .send({ defaultBillingRate: '150.00', courtReminderDays: [3, 1, 14] })
      .expect(200);
    expect(await auditRows(manager, 'OfficeSettings')).toHaveLength(1);
  });

  it.each([
    [{ courtReminderDays: [3, 3] }, 'courtReminderDays: validation.duplicate'],
    [{ courtReminderDays: [] }, 'courtReminderDays: validation.required'],
    [{ courtReminderDays: [0] }, 'courtReminderDays.0: validation.reminderRange'],
    [{ taskReminderDays: [31] }, 'taskReminderDays.0: validation.reminderRange'],
    [{ fileNumberFormat: '{YEAR}-{TYPE}' }, 'fileNumberFormat: validation.fileNumberFormat'],
    [{ fileNumberFormat: '{SEQ}-{SEQ}' }, 'fileNumberFormat: validation.fileNumberFormat'],
    [
      { fileNumberFormat: '{YEAR}-{CLIENT}-{SEQ}' },
      'fileNumberFormat: validation.fileNumberFormat',
    ],
    [{ fileNumberFormat: '<b>{SEQ}' }, 'fileNumberFormat: validation.fileNumberFormat'],
    [{ sessionIdleMinutes: 10 }, 'sessionIdleMinutes: validation.idleMinutes'],
    [{ auditRetentionDays: 364 }, 'auditRetentionDays: validation.auditRetention'],
    [{ taxRatePercent: '100.5' }, 'taxRatePercent: validation.percent'],
    [{ defaultBillingRate: '-1' }, 'defaultBillingRate: validation.amount'],
  ])('should refuse settings %j', async (body, expected) => {
    const res = await http()
      .patch('/api/v1/offices/me/settings')
      .set(as(manager))
      .send(body)
      .expect(400);
    expect(fieldsOf(res.body)).toEqual([expected]);
  });

  it('should number the next new file with a changed format', async () => {
    await http()
      .patch('/api/v1/offices/me/settings')
      .set(as(manager))
      .send({ fileNumberFormat: 'F/{SEQ:3}' })
      .expect(200);
    const client = await http()
      .post('/api/v1/clients')
      .set(as(manager))
      .send({ clientType: 'INDIVIDUAL', displayName: 'Client' })
      .expect(201);
    const file = await http()
      .post('/api/v1/cases')
      .set(as(manager))
      .send({
        title: 'Numbered',
        fileType: 'LITIGATION',
        clientIds: [client.body.data.id],
        primaryClientId: client.body.data.id,
        responsibleLawyerId: manager.userId,
      })
      .expect(201);
    expect(file.body.data.fileNumber).toBe('F/001');
  });
});
