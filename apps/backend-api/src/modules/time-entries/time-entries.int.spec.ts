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

/** D-152 on real PostgreSQL: rates, rounding, Decimal totals, who sees and changes what, and the invoice lock. */
describe('time entries (HTTP + PostgreSQL)', () => {
  let app: NestExpressApplication;
  let raw: PrismaClient;
  let jwt: JwtService;
  let manager: Person;
  let lawyer: Person;
  let paralegal: Person;
  let trainee: Person;
  let senior: Person;
  let collaborator: Person;
  let other: Person;
  let ratedFile: string;
  let plainFile: string;
  const officeIds: string[] = [];
  const savedEnv = { ...process.env };
  const http = () => request(app.getHttpServer());

  async function office(name: string, defaultBillingRate: string | null) {
    const row = await raw.office.create({
      data: {
        name,
        settings: { create: { defaultBillingRate } },
        subscriptions: liveSubscription(),
      },
    });
    officeIds.push(row.id);
    return async (role: Role): Promise<Person> => {
      const user = await raw.user.create({
        data: {
          officeId: row.id,
          fullName: role,
          email: `te-${randomUUID()}@example.test`,
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
    const inA = await office('Time office A', '100.00');
    manager = await inA('OFFICE_MANAGER');
    lawyer = await inA('LAWYER');
    paralegal = await inA('PARALEGAL');
    trainee = await inA('TRAINEE');
    senior = await inA('SENIOR_LAWYER');
    collaborator = await inA('EXTERNAL_COLLABORATOR');
    other = await (await office('Time office B', null))('OFFICE_MANAGER');
    const file = async (hourlyRate: string | null) => {
      const row = await raw.legalFile.create({
        data: {
          officeId: manager.officeId,
          fileNumber: `TE-${randomUUID()}`,
          title: 'Rent claim',
          fileType: 'LITIGATION',
          responsibleLawyerId: lawyer.userId,
          responsibleParalegalId: paralegal.userId,
          jurisdiction: 'PALESTINE',
          currency: 'ILS',
          hourlyRate,
        },
      });
      await raw.fileTeamMember.create({
        data: {
          officeId: manager.officeId,
          fileId: row.id,
          userId: trainee.userId,
          role: 'MEMBER',
        },
      });
      return row.id;
    };
    ratedFile = await file('150.00');
    plainFile = await file(null);
  }, 60_000);

  afterAll(async () => {
    if (raw) {
      const where = { officeId: { in: officeIds } };
      await raw.timeTimer.deleteMany({ where });
      await raw.timeEntry.deleteMany({ where });
      await raw.invoice.deleteMany({ where });
      await raw.client.deleteMany({ where });
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

  const log = (person: Person, body: object) =>
    http().post('/api/v1/time-entries').set(bearerFor(jwt, person)).send(body);

  it('should take the file rate, else the office default, and keep money in Decimal', async () => {
    const rated = await log(lawyer, {
      fileId: ratedFile,
      durationHours: '1.25',
      description: 'Drafted the claim',
    });
    expect(rated.status).toBe(201);
    expect(rated.body.data).toMatchObject({
      durationHours: '1.25',
      hourlyRate: '150.00',
      amount: '187.50',
      currency: 'ILS',
      invoiced: false,
      user: { id: lawyer.userId },
    });
    const fallback = await log(lawyer, {
      fileId: plainFile,
      durationHours: '2',
      description: 'Call',
    });
    expect(fallback.body.data).toMatchObject({ hourlyRate: '100.00', amount: '200.00' });
    // 0.1 + 0.1 + 0.1 is 0.30000000000000004 in floats.
    for (let i = 0; i < 3; i += 1) {
      await log(paralegal, { fileId: plainFile, durationHours: '0.1', description: 'Filing' });
    }
    await log(paralegal, {
      fileId: plainFile,
      durationHours: '0.5',
      description: 'Admin',
      isBillable: false,
    });
    const totals = await http()
      .get(`/api/v1/cases/${plainFile}/time-totals`)
      .set(bearerFor(jwt, manager));
    expect(totals.body.data).toEqual({
      currency: 'ILS',
      billableHours: '2.30',
      nonBillableHours: '0.50',
      unbilledHours: '2.30',
      billableAmount: '230.00',
      unbilledAmount: '230.00',
    });
    // A trainee has no invoice rights: hours, never money (D-096).
    const own = await log(trainee, {
      fileId: ratedFile,
      durationHours: '1',
      description: 'Research',
    });
    expect(own.body.data).toMatchObject({ hourlyRate: null, amount: null });
    const theirs = await http()
      .get(`/api/v1/cases/${plainFile}/time-totals`)
      .set(bearerFor(jwt, trainee));
    expect(theirs.body.data).toMatchObject({ billableHours: '2.30', billableAmount: null });
  });

  it('should refuse roles without log:time, future dates, and another office on the totals', async () => {
    expect(
      (await log(collaborator, { fileId: ratedFile, durationHours: '1', description: 'x' })).status,
    ).toBe(403);
    const future = await log(lawyer, {
      fileId: ratedFile,
      workDate: '2999-01-01',
      durationHours: '1',
      description: 'x',
    });
    expect(future.body.error.details).toEqual([
      expect.objectContaining({ field: 'workDate', message: 'validation.futureDate' }),
    ]);
    const totals = await http()
      .get(`/api/v1/cases/${ratedFile}/time-totals`)
      .set(bearerFor(jwt, other));
    expect(totals.status).toBe(404);
  });

  it('should refuse hours outside (0, 24] and files of another office', async () => {
    for (const durationHours of ['0', '24.01', '1.234', 'abc']) {
      const res = await log(lawyer, { fileId: ratedFile, durationHours, description: 'x' });
      expect(res.status).toBe(400);
    }
    expect(
      (await log(other, { fileId: ratedFile, durationHours: '1', description: 'x' })).status,
    ).toBe(404);
  });

  it("should let people change their own entries, the OM/SL anyone's, and nobody an invoiced one", async () => {
    const entry = (
      await log(lawyer, { fileId: ratedFile, durationHours: '1', description: 'Mine' })
    ).body.data as { id: string };
    const patch = (person: Person, body: object) =>
      http().patch(`/api/v1/time-entries/${entry.id}`).set(bearerFor(jwt, person)).send(body);
    expect((await patch(paralegal, { description: 'Not yours' })).status).toBe(404);
    const listed = await http().get('/api/v1/time-entries').set(bearerFor(jwt, paralegal));
    const authors = listed.body.data.map((e: { user: { id: string } }) => e.user.id);
    expect(authors).toContain(paralegal.userId);
    expect(authors).not.toContain(lawyer.userId);
    expect((await patch(manager, { durationHours: '1.5' })).body.data).toMatchObject({
      durationHours: '1.50',
      amount: '225.00',
    });
    expect((await patch(senior, { description: 'Corrected by SL' })).status).toBe(200);
    // Simulated: an invoice bills the entry (the real flow is covered by invoices.int.spec.ts).
    const invoice = await raw.invoice.create({
      data: {
        officeId: manager.officeId,
        clientId: (
          await raw.client.create({
            data: { officeId: manager.officeId, clientType: 'INDIVIDUAL', displayName: 'Billed' },
          })
        ).id,
        currency: 'ILS',
        subtotal: '0',
        taxRatePercent: '0',
        taxAmount: '0',
        total: '0',
        createdById: manager.userId,
      },
    });
    await raw.timeEntry.update({ where: { id: entry.id }, data: { invoiceId: invoice.id } });
    const before = await raw.timeEntry.findUnique({ where: { id: entry.id } });
    const locked = await patch(lawyer, { description: 'Too late' });
    expect(locked.status).toBe(422);
    expect(locked.body.error.code).toBe('BIZ-006');
    const remove = await http()
      .delete(`/api/v1/time-entries/${entry.id}`)
      .set(bearerFor(jwt, manager));
    expect(remove.body.error.code).toBe('BIZ-006');
    expect(await raw.timeEntry.findUnique({ where: { id: entry.id } })).toEqual(before);
    const invoiced = await http()
      .get(`/api/v1/time-entries?fileId=${ratedFile}&invoiced=true`)
      .set(bearerFor(jwt, manager));
    expect(invoiced.body.data.map((e: { id: string }) => e.id)).toEqual([entry.id]);
  });

  it('should run one timer per user and round its time up to the office increment', async () => {
    const auth = bearerFor(jwt, lawyer);
    const start = await http()
      .post('/api/v1/time-entries/timer/start')
      .set(auth)
      .send({ fileId: ratedFile, description: 'Hearing prep' });
    expect(start.status).toBe(201);
    const again = await http()
      .post('/api/v1/time-entries/timer/start')
      .set(auth)
      .send({ fileId: plainFile });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('RES-002');
    // 7 minutes ago: rounded up to two 6-minute increments.
    await raw.timeTimer.updateMany({
      where: { userId: lawyer.userId },
      data: { startedAt: new Date(Date.now() - 7 * 60_000) },
    });
    expect((await http().get('/api/v1/time-entries/timer').set(auth)).body.data).toMatchObject({
      file: { id: ratedFile },
    });
    const stop = await http().post('/api/v1/time-entries/timer/stop').set(auth).send({});
    expect(stop.status).toBe(201);
    expect(stop.body.data).toMatchObject({
      durationHours: '0.20',
      description: 'Hearing prep',
      amount: '30.00',
    });
    expect((await http().get('/api/v1/time-entries/timer').set(auth)).body.data).toBeNull();
    expect((await http().post('/api/v1/time-entries/timer/stop').set(auth).send({})).status).toBe(
      404,
    );
    // A timer on a file archived meanwhile cannot be stopped into an entry, but can be discarded.
    await http().post('/api/v1/time-entries/timer/start').set(auth).send({ fileId: plainFile });
    await raw.legalFile.update({ where: { id: plainFile }, data: { status: 'ARCHIVED' } });
    const archived = await http()
      .post('/api/v1/time-entries/timer/stop')
      .set(auth)
      .send({ description: 'x' });
    expect(archived.body.error.code).toBe('BIZ-007');
    expect((await http().delete('/api/v1/time-entries/timer').set(auth)).status).toBe(204);
    expect((await http().get('/api/v1/time-entries/timer').set(auth)).body.data).toBeNull();
    await raw.legalFile.update({ where: { id: plainFile }, data: { status: 'OPEN' } });
  });
});
