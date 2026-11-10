import { randomUUID } from 'node:crypto';

import { JwtService } from '@nestjs/jwt';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Role } from '@nexlegtiq/shared-types';
import type { PinoLogger } from 'nestjs-pino';
import request from 'supertest';

import { InvoiceOverdueSweep } from './invoice-overdue.sweep';
import { AppModule } from '../../app/app.module';
import { configureApp } from '../../app/configure-app';
import { AuditService } from '../../common/audit/audit.service';
import { TenantRunner } from '../../common/tenancy/tenant-runner';
import { integrationEnv } from '../../config/env.fixture';
import { PrismaService } from '../../database/prisma.service';
import { TENANT_MODELS } from '../../database/tenant-models';
import { UnitOfWork } from '../../database/unit-of-work';
import type { PrismaClient } from '../../generated/prisma/client';
import { bearerFor } from '../auth/auth.test-helper';
import { liveSubscription } from '../subscriptions/subscription.test-helper';

type Person = { userId: string; officeId: string; role: Role };
type Delegate = { deleteMany(args: unknown): Promise<unknown> };

/** D-162 on real PostgreSQL: drafting from time, rounding, numbering, lifecycle, visibility and isolation. */
describe('invoices (HTTP + PostgreSQL)', () => {
  let app: NestExpressApplication;
  let raw: PrismaClient;
  let jwt: JwtService;
  let manager: Person;
  let lawyer: Person;
  let senior: Person;
  let admin: Person;
  let paralegal: Person;
  let trainee: Person;
  let other: Person;
  let f1: string;
  let f2: string;
  let fUsd: string;
  let fConf: string;
  let fJod: string;
  let client: string;
  let jodClient: string;
  const officeIds: string[] = [];
  const savedEnv = { ...process.env };
  const http = () => request(app.getHttpServer());
  const as = (person: Person) => bearerFor(jwt, person);

  async function office(name: string, taxRatePercent: string) {
    const row = await raw.office.create({
      data: { name, settings: { create: { taxRatePercent } }, subscriptions: liveSubscription() },
    });
    officeIds.push(row.id);
    return async (role: Role): Promise<Person> => {
      const user = await raw.user.create({
        data: {
          officeId: row.id,
          fullName: role,
          email: `inv-${randomUUID()}@example.test`,
          passwordHash: '!',
          role,
        },
      });
      return { userId: user.id, officeId: row.id, role };
    };
  }

  const makeFile = async (currency: string, responsible: Person, isConfidential = false) => {
    const row = await raw.legalFile.create({
      data: {
        officeId: manager.officeId,
        fileNumber: `INV-${randomUUID()}`,
        title: 'Invoice file',
        fileType: 'LITIGATION',
        responsibleLawyerId: responsible.userId,
        jurisdiction: 'PALESTINE',
        currency,
        isConfidential,
      },
    });
    return row.id;
  };
  const link = (fileId: string, clientId: string) =>
    raw.fileClient.create({
      data: { officeId: manager.officeId, fileId, clientId, isPrimary: true },
    });
  const makeClient = async () =>
    (
      await raw.client.create({
        data: {
          officeId: manager.officeId,
          clientType: 'INDIVIDUAL',
          displayName: 'Invoice client',
        },
      })
    ).id;
  const entry = (
    fileId: string,
    hours: string,
    rate: string | null,
    extra: Partial<{ workDate: string; isBillable: boolean; currency: string }> = {},
  ) =>
    raw.timeEntry.create({
      data: {
        officeId: manager.officeId,
        fileId,
        userId: manager.userId,
        workDate: new Date(`${extra.workDate ?? '2026-11-02'}T00:00:00Z`),
        durationHours: hours,
        description: 'Work',
        hourlyRate: rate,
        isBillable: extra.isBillable ?? true,
        currency: extra.currency ?? 'ILS',
      },
    });
  const draft = (person: Person, body: object) =>
    http()
      .post('/api/v1/invoices')
      .set(as(person))
      .send({ periodStart: '2026-11-01', periodEnd: '2026-11-30', ...body });
  const clearEntries = async () => {
    await raw.invoiceLineItem.deleteMany({ where: { officeId: manager.officeId } });
    await raw.timeEntry.deleteMany({ where: { officeId: manager.officeId } });
    await raw.invoice.deleteMany({ where: { officeId: manager.officeId } });
    await raw.caseTimelineEvent.deleteMany({ where: { officeId: manager.officeId } });
  };

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
    const inA = await office('Invoice office A', '16.00');
    manager = await inA('OFFICE_MANAGER');
    lawyer = await inA('LAWYER');
    senior = await inA('SENIOR_LAWYER');
    admin = await inA('ADMIN');
    paralegal = await inA('PARALEGAL');
    trainee = await inA('TRAINEE');
    other = await (await office('Invoice office B', '0'))('OFFICE_MANAGER');
    f1 = await makeFile('ILS', lawyer);
    f2 = await makeFile('ILS', lawyer);
    fUsd = await makeFile('USD', lawyer);
    fConf = await makeFile('ILS', manager, true);
    fJod = await makeFile('JOD', lawyer);
    client = await makeClient();
    jodClient = await makeClient();
    for (const file of [f1, f2, fUsd, fConf]) await link(file, client);
    await link(fJod, jodClient);
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

  beforeEach(clearEntries);

  it('should draft a per-file invoice from unbilled billable time, rounding half-even with tax once', async () => {
    await entry(f1, '1.50', '150.00');
    await entry(f1, '0.25', '150.00');
    await entry(f1, '1.00', '150.00', { isBillable: false });
    await entry(f1, '1.00', '150.00', { workDate: '2026-12-05' });
    const res = await draft(manager, {
      clientId: client,
      fileId: f1,
      extraLines: [{ description: 'Court fee', quantity: '2', unitPrice: '10.005' }],
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      status: 'DRAFT',
      invoiceNumber: null,
      issueDate: null,
      dueDate: null,
      currency: 'ILS',
      subtotal: '282.51',
      taxRatePercent: '16.00',
      taxAmount: '45.20',
      total: '327.71',
    });
    expect(res.body.data.lines).toHaveLength(3);
    expect(res.body.data.lines.map((line: { amount: string }) => line.amount)).toEqual([
      '225.00',
      '37.50',
      '20.01',
    ]);
    const linked = await raw.timeEntry.count({ where: { invoiceId: res.body.data.id } });
    expect(linked).toBe(2);
    // The same entries cannot be billed twice.
    const again = await draft(manager, { clientId: client, fileId: f1 });
    expect(again.status).toBe(400);
    expect(again.body.error.details[0].message).toBe('validation.nothingToInvoice');
  });

  it('should keep the currency digits (JOD 3) and skip tax when not included', async () => {
    await entry(fJod, '0.33', '10.50', { currency: 'JOD' });
    const res = await draft(manager, { clientId: jodClient, includeTax: false });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      currency: 'JOD',
      subtotal: '3.465',
      taxRatePercent: '0.00',
      taxAmount: '0.000',
      total: '3.465',
    });
  });

  it('should draft a consolidated invoice across two files and put INVOICE_SENT on both', async () => {
    await entry(f1, '1.00', '100.00');
    await entry(f2, '2.00', '100.00');
    const res = await draft(manager, { clientId: client, includeTax: false });
    expect(res.status).toBe(201);
    // fUsd/fConf have no entries: only f1 and f2 are billed.
    expect(res.body.data).toMatchObject({ file: null, subtotal: '300.00', total: '300.00' });
    const sent = await http()
      .post(`/api/v1/invoices/${res.body.data.id}/send`)
      .set(as(manager))
      .expect(200);
    expect(sent.body.data.status).toBe('SENT');
    const events = await raw.caseTimelineEvent.findMany({
      where: { officeId: manager.officeId, eventType: 'INVOICE_SENT' },
      select: { fileId: true },
    });
    expect(events.map((event) => event.fileId).sort()).toEqual([f1, f2].sort());
  });

  it('should refuse an invoice that mixes currencies (BIZ-021)', async () => {
    await entry(f1, '1.00', '100.00');
    await entry(fUsd, '1.00', '100.00', { currency: 'USD' });
    const res = await draft(manager, { clientId: client });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('BIZ-021');
    expect(await raw.invoice.count({ where: { officeId: manager.officeId } })).toBe(0);
  });

  it('should refuse unrated entries and an empty period, and unknown clients and files', async () => {
    await entry(f1, '1.00', null);
    const unrated = await draft(manager, { clientId: client, fileId: f1 });
    expect(unrated.status).toBe(400);
    expect(unrated.body.error.details[0].message).toBe('validation.missingRate');
    const empty = await draft(manager, { clientId: client, fileId: f2 });
    expect(empty.body.error.details[0].message).toBe('validation.nothingToInvoice');
    const noClient = await draft(manager, { clientId: randomUUID(), fileId: f1 });
    expect(noClient.body.error.details[0].message).toBe('validation.unknownClient');
    const notLinked = await draft(manager, { clientId: jodClient, fileId: f1 });
    expect(notLinked.body.error.details[0].message).toBe('validation.clientNotOnFile');
    const noFile = await draft(manager, { clientId: client, fileId: randomUUID() });
    expect(noFile.status).toBe(404);
  });

  it('should number on send gap-free, also for concurrent sends, and fix the dates', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      await entry(f1, '1.00', '100.00', { workDate: `2026-11-0${i + 1}` });
      const res = await draft(manager, {
        clientId: client,
        fileId: f1,
        periodStart: `2026-11-0${i + 1}`,
        periodEnd: `2026-11-0${i + 1}`,
      });
      ids.push(res.body.data.id);
    }
    const sent = await Promise.all(
      ids.map((id) => http().post(`/api/v1/invoices/${id}/send`).set(as(manager))),
    );
    expect(sent.map((res) => res.status)).toEqual([200, 200, 200, 200]);
    const numbers = sent.map((res) => res.body.data.invoiceNumber as string);
    expect(new Set(numbers).size).toBe(4);
    const seqs = numbers.map((n) => Number(n.split('-')[2])).sort((a, b) => a - b);
    expect((seqs[3] as number) - (seqs[0] as number)).toBe(3);
    expect(numbers[0]).toMatch(/^INV-\d{4}-\d{4}$/);
    const { issueDate, dueDate } = (sent[0] as (typeof sent)[number]).body.data;
    expect((Date.parse(dueDate) - Date.parse(issueDate)) / 86_400_000).toBe(30);
    // Sending again is refused.
    const twice = await http().post(`/api/v1/invoices/${ids[0]}/send`).set(as(manager));
    expect(twice.body.error.code).toBe('BIZ-006');
  });

  it('should void a sent invoice, free its entries and keep its number', async () => {
    const e = await entry(f1, '1.00', '100.00');
    const created = await draft(manager, { clientId: client, fileId: f1 });
    const id = created.body.data.id as string;
    const sent = await http().post(`/api/v1/invoices/${id}/send`).set(as(manager));
    // The entry is locked while invoiced (BIZ-006).
    const locked = await http()
      .patch(`/api/v1/time-entries/${e.id}`)
      .set(as(manager))
      .send({ description: 'Changed' });
    expect(locked.body.error.code).toBe('BIZ-006');
    const voided = await http().post(`/api/v1/invoices/${id}/void`).set(as(manager)).expect(200);
    expect(voided.body.data).toMatchObject({
      status: 'VOID',
      invoiceNumber: sent.body.data.invoiceNumber,
    });
    expect((await raw.timeEntry.findUniqueOrThrow({ where: { id: e.id } })).invoiceId).toBeNull();
    await http()
      .patch(`/api/v1/time-entries/${e.id}`)
      .set(as(manager))
      .send({ description: 'Changed' })
      .expect(200);
    const voidAgain = await http().post(`/api/v1/invoices/${id}/void`).set(as(manager));
    expect(voidAgain.body.error.code).toBe('BIZ-006');
    // Its hours can be invoiced again.
    await draft(manager, { clientId: client, fileId: f1 }).then((res) =>
      expect(res.status).toBe(201),
    );
  });

  it('should edit and delete only drafts; deleting frees the entries', async () => {
    const e = await entry(f1, '1.00', '100.00');
    const created = await draft(manager, { clientId: client, fileId: f1, includeTax: false });
    const id = created.body.data.id as string;
    const patched = await http()
      .patch(`/api/v1/invoices/${id}`)
      .set(as(manager))
      .send({
        notes: 'Thanks',
        includeTax: true,
        extraLines: [{ description: 'Stamp', quantity: '1', unitPrice: '5.00' }],
      })
      .expect(200);
    expect(patched.body.data).toMatchObject({
      notes: 'Thanks',
      subtotal: '105.00',
      taxAmount: '16.80',
      total: '121.80',
    });
    expect(patched.body.data.lines).toHaveLength(2);
    await http().delete(`/api/v1/invoices/${id}`).set(as(manager)).expect(204);
    expect((await raw.timeEntry.findUniqueOrThrow({ where: { id: e.id } })).invoiceId).toBeNull();
    await http().get(`/api/v1/invoices/${id}`).set(as(manager)).expect(404);

    await entry(f1, '1.00', '100.00');
    const sentId = (await draft(manager, { clientId: client, fileId: f1 })).body.data.id;
    await http().post(`/api/v1/invoices/${sentId}/send`).set(as(manager)).expect(200);
    const patch = await http()
      .patch(`/api/v1/invoices/${sentId}`)
      .set(as(manager))
      .send({ notes: 'x' });
    expect(patch.body.error.code).toBe('BIZ-006');
    const del = await http().delete(`/api/v1/invoices/${sentId}`).set(as(manager));
    expect(del.body.error.code).toBe('BIZ-006');
  });

  it('should mark a sent invoice paid with INVOICE_PAID, and refuse a draft or a second payment', async () => {
    await entry(f1, '1.00', '100.00');
    const id = (await draft(manager, { clientId: client, fileId: f1 })).body.data.id as string;
    const pay = { paidAt: '2026-11-10T09:00:00+02:00', method: 'BANK_TRANSFER', reference: 'TX-1' };
    const early = await http().post(`/api/v1/invoices/${id}/mark-paid`).set(as(manager)).send(pay);
    expect(early.body.error.code).toBe('BIZ-006');
    await http().post(`/api/v1/invoices/${id}/send`).set(as(manager)).expect(200);
    const paid = await http()
      .post(`/api/v1/invoices/${id}/mark-paid`)
      .set(as(manager))
      .send(pay)
      .expect(200);
    expect(paid.body.data).toMatchObject({
      status: 'PAID',
      paymentMethod: 'BANK_TRANSFER',
      paymentReference: 'TX-1',
    });
    const again = await http().post(`/api/v1/invoices/${id}/mark-paid`).set(as(manager)).send(pay);
    expect(again.body.error.code).toBe('BIZ-006');
    const voidPaid = await http().post(`/api/v1/invoices/${id}/void`).set(as(manager));
    expect(voidPaid.body.error.code).toBe('BIZ-006');
    expect(
      await raw.caseTimelineEvent.count({
        where: { officeId: manager.officeId, eventType: 'INVOICE_PAID' },
      }),
    ).toBe(1);
  });

  it('should turn a sent invoice overdue after its due date, by the daily sweep', async () => {
    await entry(f1, '1.00', '100.00');
    const id = (await draft(manager, { clientId: client, fileId: f1, dueDate: '2099-01-01' })).body
      .data.id as string;
    await http().post(`/api/v1/invoices/${id}/send`).set(as(manager)).expect(200);
    const sweep = new InvoiceOverdueSweep(
      app.get(PrismaService),
      app.get(TenantRunner),
      app.get(UnitOfWork),
      app.get(AuditService),
      { setContext: () => undefined, info: () => undefined } as unknown as PinoLogger,
    );
    await sweep.run();
    expect((await raw.invoice.findUniqueOrThrow({ where: { id } })).status).toBe('SENT');
    await raw.invoice.update({
      where: { id },
      data: { dueDate: new Date('2026-01-01T00:00:00Z') },
    });
    await sweep.run();
    expect((await raw.invoice.findUniqueOrThrow({ where: { id } })).status).toBe('OVERDUE');
    // An overdue invoice can still be paid.
    await http()
      .post(`/api/v1/invoices/${id}/mark-paid`)
      .set(as(manager))
      .send({ paidAt: '2026-11-10T09:00:00+02:00', method: 'CASH' })
      .expect(200);
  });

  it('should show invoices by the caller scope: all, assigned, and hide confidential files', async () => {
    await entry(f1, '1.00', '100.00');
    await entry(fConf, '1.00', '100.00');
    const mine = (await draft(manager, { clientId: client, fileId: f1 })).body.data.id as string;
    const secret = (await draft(manager, { clientId: client, fileId: fConf })).body.data
      .id as string;
    const ids = async (person: Person) =>
      (
        (await http().get('/api/v1/invoices?limit=100').set(as(person)).expect(200)).body.data as {
          id: string;
        }[]
      )
        .map((row) => row.id)
        .sort();
    expect(await ids(manager)).toEqual([mine, secret].sort());
    // The lawyer is assigned to f1 only; the admin sees every office invoice except confidential ones.
    expect(await ids(lawyer)).toEqual([mine]);
    expect(await ids(admin)).toEqual([mine]);
    expect(await ids(senior)).toEqual([]);
    await http().get(`/api/v1/invoices/${secret}`).set(as(lawyer)).expect(404);
    await http().get(`/api/v1/invoices/${secret}`).set(as(admin)).expect(404);
    await http().get(`/api/v1/invoices/${mine}`).set(as(paralegal)).expect(404);
    // A consolidated invoice needs all its files visible.
    await entry(f2, '1.00', '100.00');
    await entry(fConf, '1.00', '100.00');
    const both = (await draft(manager, { clientId: client })).body.data.id as string;
    const lineFiles = (await raw.invoiceLineItem.findMany({ where: { invoiceId: both } })).map(
      (l) => l.fileId,
    );
    expect(lineFiles.sort()).toEqual([f2, fConf].sort());
    expect(await ids(lawyer)).not.toContain(both);
    expect(await ids(manager)).toContain(both);
  });

  it('should filter the list and refuse callers without the permission', async () => {
    await entry(f1, '1.00', '100.00');
    const id = (await draft(manager, { clientId: client, fileId: f1 })).body.data.id as string;
    await http().post(`/api/v1/invoices/${id}/send`).set(as(manager)).expect(200);
    const filtered = await http()
      .get(
        `/api/v1/invoices?status=SENT&clientId=${client}&fileId=${f1}&from=2000-01-01&sort=total:asc`,
      )
      .set(as(manager))
      .expect(200);
    expect(filtered.body.meta.pagination.total).toBe(1);
    const none = await http().get('/api/v1/invoices?status=PAID').set(as(manager)).expect(200);
    expect(none.body.data).toEqual([]);
    await http().get('/api/v1/invoices').set(as(trainee)).expect(403);
    await draft(trainee, { clientId: client }).then((res) => expect(res.status).toBe(403));
    await draft(paralegal, { clientId: client }).then((res) => expect(res.status).toBe(403));
    const pay = { paidAt: '2026-11-10T09:00:00+02:00', method: 'CASH' };
    await http().post(`/api/v1/invoices/${id}/mark-paid`).set(as(paralegal)).send(pay).expect(403);
    await http().post(`/api/v1/invoices/${id}/mark-paid`).set(as(manager)).send({}).expect(400);
  });

  it("should answer 404 for another office's invoice and a malformed id", async () => {
    await entry(f1, '1.00', '100.00');
    const id = (await draft(manager, { clientId: client, fileId: f1 })).body.data.id as string;
    await http().get(`/api/v1/invoices/${id}`).set(as(other)).expect(404);
    await http().post(`/api/v1/invoices/${id}/send`).set(as(other)).expect(404);
    await http().post(`/api/v1/invoices/${id}/void`).set(as(other)).expect(404);
    await http().get('/api/v1/invoices/not-a-uuid').set(as(manager)).expect(404);
    const foreign = await draft(other, { clientId: client, fileId: f1 });
    expect(foreign.status).toBe(400);
  });

  it('should refuse writes while the subscription is read-only (AUTH-104)', async () => {
    const person = await (await office('Invoice office C', '0'))('OFFICE_MANAGER');
    await raw.subscription.updateMany({
      where: { officeId: person.officeId },
      data: { status: 'CANCELLED' },
    });
    const res = await draft(person, { clientId: randomUUID() });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('AUTH-104');
    await http().get('/api/v1/invoices').set(as(person)).expect(200);
  });
});
