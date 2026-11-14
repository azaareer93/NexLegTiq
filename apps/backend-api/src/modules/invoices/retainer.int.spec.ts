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

type Person = { userId: string; officeId: string; role: Role };
type Delegate = { deleteMany(args: unknown): Promise<unknown> };

const PAID_AT = '2026-11-10T09:00:00+02:00';

/** D-176 on real PostgreSQL: deposits, payment from the retainer, rounding, races, visibility and isolation. */
describe('retainer (HTTP + PostgreSQL)', () => {
  let app: NestExpressApplication;
  let raw: PrismaClient;
  let jwt: JwtService;
  let manager: Person;
  let lawyer: Person;
  let trainee: Person;
  let other: Person;
  let client: string;
  const officeIds: string[] = [];
  const savedEnv = { ...process.env };
  const http = () => request(app.getHttpServer());
  const as = (person: Person) => bearerFor(jwt, person);

  async function office(name: string) {
    const row = await raw.office.create({
      data: { name, settings: { create: {} }, subscriptions: liveSubscription() },
    });
    officeIds.push(row.id);
    return async (role: Role): Promise<Person> => {
      const user = await raw.user.create({
        data: {
          officeId: row.id,
          fullName: role,
          email: `ret-${randomUUID()}@example.test`,
          passwordHash: '!',
          role,
        },
      });
      return { userId: user.id, officeId: row.id, role };
    };
  }
  const makeFile = async (currency: string, responsible: Person = lawyer) =>
    (
      await raw.legalFile.create({
        data: {
          officeId: responsible.officeId,
          fileNumber: `RET-${randomUUID()}`,
          title: 'Retainer file',
          fileType: 'LITIGATION',
          responsibleLawyerId: responsible.userId,
          jurisdiction: 'PALESTINE',
          currency,
          billingMethod: 'RETAINER',
        },
      })
    ).id;
  const sentInvoice = async (fileId: string | null, total: string, currency = 'ILS') =>
    (
      await raw.invoice.create({
        data: {
          officeId: manager.officeId,
          clientId: client,
          fileId,
          invoiceNumber: `INV-2026-${randomUUID().slice(0, 6)}`,
          status: 'SENT',
          currency,
          issueDate: new Date('2026-11-01T00:00:00Z'),
          dueDate: new Date('2026-12-01T00:00:00Z'),
          sentAt: new Date('2026-11-01T00:00:00Z'),
          subtotal: total,
          taxRatePercent: '0',
          taxAmount: '0',
          total,
          createdById: manager.userId,
        },
      })
    ).id;
  const deposit = (person: Person, fileId: string, body: object) =>
    http()
      .post(`/api/v1/cases/${fileId}/retainer/deposit`)
      .set(as(person))
      .send({ paidAt: PAID_AT, method: 'BANK_TRANSFER', ...body });
  const payFromRetainer = (person: Person, invoiceId: string) =>
    http()
      .post(`/api/v1/invoices/${invoiceId}/mark-paid`)
      .set(as(person))
      .send({ paidAt: PAID_AT, method: 'RETAINER' });

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
    const inA = await office('Retainer office A');
    manager = await inA('OFFICE_MANAGER');
    lawyer = await inA('LAWYER');
    trainee = await inA('TRAINEE');
    other = await (await office('Retainer office B'))('OFFICE_MANAGER');
    client = (
      await raw.client.create({
        data: {
          officeId: manager.officeId,
          clientType: 'INDIVIDUAL',
          displayName: 'Retainer client',
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

  it('should record deposits as ledger entries whose sum is the balance, audited and on the timeline', async () => {
    const file = await makeFile('ILS');
    await deposit(manager, file, { amount: '1000', reference: 'TRX-9' }).expect(201);
    const res = await deposit(lawyer, file, { amount: '250.50', method: 'CASH' }).expect(201);
    expect(res.body.data).toMatchObject({ fileId: file, currency: 'ILS', balance: '1250.50' });
    expect(res.body.data.entries.map((e: { amount: string }) => e.amount).sort()).toEqual([
      '1000.00',
      '250.50',
    ]);
    const row = await raw.legalFile.findUniqueOrThrow({ where: { id: file } });
    expect(row.retainerBalance.toFixed(2)).toBe('1250.50');
    await expect(
      raw.caseTimelineEvent.count({ where: { fileId: file, eventType: 'RETAINER_DEPOSITED' } }),
    ).resolves.toBe(2);
    await expect(
      raw.auditLog.count({ where: { officeId: manager.officeId, entityType: 'RetainerEntry' } }),
    ).resolves.toBeGreaterThanOrEqual(2);
    const view = await http().get(`/api/v1/cases/${file}/retainer`).set(as(lawyer)).expect(200);
    expect(view.body.data.balance).toBe('1250.50');
  });

  it('should round to the currency: three digits for JOD, and refuse more than ILS has', async () => {
    const jod = await makeFile('JOD');
    const res = await deposit(manager, jod, { amount: '10.125' }).expect(201);
    expect(res.body.data.balance).toBe('10.125');
    const ils = await makeFile('ILS');
    const bad = await deposit(manager, ils, { amount: '10.125' }).expect(400);
    expect(bad.body.error.details[0].field).toBe('amount');
    await deposit(manager, ils, { amount: '10.500' }).expect(201);
    await deposit(manager, ils, { amount: '5', paidAt: '2999-01-01T09:00:00+02:00' }).expect(400);
  });

  it('should pay a per-file invoice from the retainer in one transaction, and refuse when the balance is short', async () => {
    const file = await makeFile('ILS');
    await deposit(manager, file, { amount: '300' }).expect(201);
    const short = await sentInvoice(file, '350.00');
    const refused = await payFromRetainer(manager, short).expect(422);
    expect(refused.body.error.code).toBe('BIZ-005');
    await expect(raw.invoice.findUniqueOrThrow({ where: { id: short } })).resolves.toMatchObject({
      status: 'SENT',
    });

    const fits = await sentInvoice(file, '120.40');
    const paid = await payFromRetainer(manager, fits).expect(200);
    expect(paid.body.data).toMatchObject({ status: 'PAID', paymentMethod: 'RETAINER' });
    const retainer = await http()
      .get(`/api/v1/cases/${file}/retainer`)
      .set(as(manager))
      .expect(200);
    expect(retainer.body.data.balance).toBe('179.60');
    expect(retainer.body.data.entries[0]).toMatchObject({
      kind: 'INVOICE_PAYMENT',
      amount: '-120.40',
      invoice: { id: fits },
    });
  });

  it('should refuse a consolidated invoice or one in another currency', async () => {
    const file = await makeFile('ILS');
    await deposit(manager, file, { amount: '500' }).expect(201);
    const consolidated = await sentInvoice(null, '10.00');
    const a = await payFromRetainer(manager, consolidated).expect(400);
    expect(a.body.error.details[0]).toMatchObject({
      field: 'method',
      message: 'validation.retainerNeedsFile',
    });
    const usd = await sentInvoice(file, '10.00', 'USD');
    const b = await payFromRetainer(manager, usd).expect(400);
    expect(b.body.error.details[0]).toMatchObject({ message: 'validation.retainerCurrency' });
  });

  it('should never overdraw when two payments race for the same balance', async () => {
    const file = await makeFile('ILS');
    await deposit(manager, file, { amount: '100' }).expect(201);
    const [one, two] = [await sentInvoice(file, '80.00'), await sentInvoice(file, '80.00')];
    const results = await Promise.all([
      payFromRetainer(manager, one),
      payFromRetainer(manager, two),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 422]);
    const row = await raw.legalFile.findUniqueOrThrow({ where: { id: file } });
    expect(row.retainerBalance.toFixed(2)).toBe('20.00');
    await expect(raw.retainerEntry.count({ where: { fileId: file } })).resolves.toBe(2);
  });

  it('should apply the invoice rights: trainee and other office cannot see or touch the retainer', async () => {
    const file = await makeFile('ILS');
    await http().get(`/api/v1/cases/${file}/retainer`).set(as(trainee)).expect(403);
    await deposit(trainee, file, { amount: '10' }).expect(403);
    await http().get(`/api/v1/cases/${file}/retainer`).set(as(other)).expect(404);
    await deposit(other, file, { amount: '10' }).expect(404);
    await http().get(`/api/v1/cases/${randomUUID()}/retainer`).set(as(manager)).expect(404);
    await http().get('/api/v1/cases/not-a-uuid/retainer').set(as(manager)).expect(404);
    const res = await deposit(manager, file, { amount: '0' }).expect(400);
    expect(res.body.error.details[0].field).toBe('amount');
  });
});
