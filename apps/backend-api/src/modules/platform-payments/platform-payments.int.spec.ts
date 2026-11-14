import { randomUUID } from 'node:crypto';

import { JwtService } from '@nestjs/jwt';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Queue } from 'bullmq';
import request from 'supertest';

import { AppModule } from '../../app/app.module';
import { configureApp } from '../../app/configure-app';
import { getQueue, QUEUE } from '../../common/queue/queues';
import { integrationEnv } from '../../config/env.fixture';
import { PrismaService } from '../../database/prisma.service';
import type { PrismaClient } from '../../generated/prisma/client';
import { bearerFor } from '../auth/auth.test-helper';
import { PasswordHasher } from '../auth/password-hasher';
import { totpCode, totpStep } from '../platform-auth/totp';

const PASSWORD = 'Admin-Correct-Horse-9';
const ORIGIN = 'http://localhost:4201';
const YEAR = new Date().getUTCFullYear();

/** Manual payments and receipts (MVP-170, D-174) on real PostgreSQL and Redis. */
describe('platform admin payments (HTTP + PostgreSQL)', () => {
  let app: NestExpressApplication;
  let raw: PrismaClient;
  const savedEnv = { ...process.env };
  const http = () => request(app.getHttpServer());
  const officeIds: string[] = [];
  let email = '';
  let adminId = '';
  let planId = '';
  let auth = { Authorization: '' };

  beforeAll(async () => {
    Object.assign(process.env, integrationEnv(), {
      ADMIN_JWT_SECRET: 'integration-only-admin-secret-0123456789abcdef',
      ADMIN_IP_ALLOWLIST: '127.0.0.1, ::1',
      CORS_ORIGINS: ORIGIN,
      ADMIN_ORIGINS: ORIGIN,
    });
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = module.createNestApplication<NestExpressApplication>({ bufferLogs: true });
    configureApp(app);
    await app.init();
    // unscoped: platform fixtures.
    raw = app.get(PrismaService).unscoped();
    planId = (await raw.plan.findFirstOrThrow({ select: { id: true } })).id;

    email = `admin-${randomUUID()}@example.test`;
    const admin = await raw.platformAdmin.create({
      data: {
        email,
        fullName: 'Platform Admin',
        passwordHash: await new PasswordHasher().hash(PASSWORD),
      },
    });
    adminId = admin.id;
    const enroll = await http()
      .post('/api/v1/admin/auth/enroll')
      .send({ email, password: PASSWORD })
      .expect(200);
    const confirmed = await http()
      .post('/api/v1/admin/auth/enroll/confirm')
      .send({
        email,
        password: PASSWORD,
        code: totpCode(enroll.body.data.secret as string, totpStep(new Date())),
      })
      .expect(201);
    auth = { Authorization: `Bearer ${confirmed.body.data.accessToken as string}` };
  });

  afterAll(async () => {
    if (!raw) return;
    await raw.platformPayment.deleteMany({ where: { officeId: { in: officeIds } } });
    await raw.platformAuditLog.deleteMany({ where: { adminId } });
    await raw.platformSession.deleteMany({ where: { adminId } });
    await raw.platformRecoveryCode.deleteMany({ where: { adminId } });
    await raw.platformAdmin.deleteMany({ where: { id: adminId } });
    await raw.loginAttempt.deleteMany({ where: { email } });
    await raw.subscription.deleteMany({ where: { officeId: { in: officeIds } } });
    await raw.office.deleteMany({ where: { id: { in: officeIds } } });
    await app?.close();
    process.env = savedEnv;
  });

  async function office(officeEmail: string | null = 'office@example.test') {
    const row = await raw.office.create({
      data: {
        name: `pay-${randomUUID().slice(0, 6)}`,
        jurisdiction: 'PALESTINE',
        email: officeEmail,
        subscriptions: {
          create: { planId, status: 'ACTIVE', currentPeriodStart: new Date() },
        },
      },
    });
    officeIds.push(row.id);
    return row.id;
  }

  const payment = (over: Record<string, unknown> = {}) => ({
    amount: '150.50',
    currency: 'ILS',
    method: 'BANK_TRANSFER',
    reference: 'TRX-1',
    paidAt: new Date().toISOString().slice(0, 10),
    ...over,
  });
  const record = (officeId: string, body: object = payment()) =>
    http().post(`/api/v1/admin/offices/${officeId}/payments`).set(auth).send(body);
  const seq = (receipt: string) => Number(receipt.split('-')[2]);

  it('should refuse payments without an admin session', async () => {
    const id = await office();
    await http().get(`/api/v1/admin/offices/${id}/payments`).expect(401);
    await http().post(`/api/v1/admin/offices/${id}/payments`).send(payment()).expect(401);
  });

  it('should record a payment with a receipt number, audit it, queue the emailed receipt and leave the subscription alone', async () => {
    const id = await office();
    const before = await raw.subscription.findFirstOrThrow({ where: { officeId: id } });
    const res = await record(id).expect(201);
    const paid = res.body.data;
    expect(paid).toMatchObject({
      officeId: id,
      amount: '150.50',
      currency: 'ILS',
      method: 'BANK_TRANSFER',
      reference: 'TRX-1',
      voidedAt: null,
      recordedBy: { id: adminId, fullName: 'Platform Admin' },
    });
    expect(paid.receiptNumber).toMatch(new RegExp(`^RCT-(${YEAR}|${YEAR + 1})-\\d{4,}$`));

    const after = await raw.subscription.findFirstOrThrow({ where: { officeId: id } });
    expect(after).toEqual(before);
    const audit = await raw.platformAuditLog.findFirstOrThrow({
      where: { adminId, action: 'PAYMENT_RECORDED', entityId: paid.id },
    });
    expect(audit.targetOfficeId).toBe(id);
    const job = await (getQueue(app, QUEUE.REPORT) as Queue).getJob(
      `${id}_receipt-${paid.id as string}-record`,
    );
    expect(job?.name).toBe('render-payment-receipt');
    expect(job?.data).toMatchObject({ paymentId: paid.id, email: true, officeId: id });
    await job?.remove();

    const list = await http().get(`/api/v1/admin/offices/${id}/payments`).set(auth).expect(200);
    expect(list.body.data.map((p: { id: string }) => p.id)).toEqual([paid.id]);
  });

  it('should number concurrent payments gap-free across offices', async () => {
    const [a, b] = [await office(), await office()];
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => record(i % 2 ? a : b, payment({ emailOffice: false }))),
    );
    const numbers = results.map((r) => {
      expect(r.status).toBe(201);
      return r.body.data.receiptNumber as string;
    });
    const values = numbers.map(seq).sort((x, y) => x - y);
    expect(new Set(numbers).size).toBe(6);
    // Consecutive: no number skipped or reused between them.
    const first = values[0] ?? 0;
    expect(values).toEqual(values.map((_, i) => first + i));
  });

  it('should refuse bad input, a future day, too many decimals, a missing office email and an unknown office', async () => {
    const id = await office(null);
    const tomorrow = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    const field = async (body: object, expected: string) => {
      const res = await record(id, body).expect(400);
      expect(res.body.error.details).toEqual(
        expect.arrayContaining([expect.objectContaining({ field: expected })]),
      );
    };
    await field(payment({ amount: '0', emailOffice: false }), 'amount');
    await field(payment({ amount: '1.005', emailOffice: false }), 'amount');
    await field(payment({ method: 'CARD', emailOffice: false }), 'method');
    await field(payment({ paidAt: tomorrow, emailOffice: false }), 'paidAt');
    await field(payment(), 'emailOffice');
    // JOD has three decimals.
    await record(id, payment({ amount: '10.125', currency: 'JOD', emailOffice: false })).expect(
      201,
    );
    await record(randomUUID(), payment()).expect(404);
    await http().get(`/api/v1/admin/offices/${randomUUID()}/payments`).set(auth).expect(404);
  });

  it('should void a payment once, keeping its number', async () => {
    const id = await office();
    const paid = (await record(id, payment({ emailOffice: false })).expect(201)).body.data;
    const voided = await http()
      .post(`/api/v1/admin/payments/${paid.id as string}/void`)
      .set(auth)
      .send({ reason: 'recorded twice' })
      .expect(200);
    expect(voided.body.data).toMatchObject({
      receiptNumber: paid.receiptNumber,
      voidReason: 'recorded twice',
    });
    expect(voided.body.data.voidedAt).not.toBeNull();
    const again = await http()
      .post(`/api/v1/admin/payments/${paid.id as string}/void`)
      .set(auth)
      .send({ reason: 'recorded twice' })
      .expect(422);
    expect(again.body.error.code).toBe('BIZ-024');
    await http()
      .post(`/api/v1/admin/payments/${randomUUID()}/void`)
      .set(auth)
      .send({ reason: 'nope' })
      .expect(404);
    expect(
      await raw.platformAuditLog.count({
        where: { adminId, action: 'PAYMENT_VOIDED', entityId: paid.id },
      }),
    ).toBe(1);
  });

  it('should queue the receipt render, then hand out a link to the stored PDF', async () => {
    const id = await office();
    const paid = (await record(id, payment({ emailOffice: false })).expect(201)).body.data;
    const url = `/api/v1/admin/payments/${paid.id as string}/receipt?language=EN`;
    const pending = await http().get(url).set(auth).expect(202);
    expect(pending.body.data).toEqual({ status: 'RENDERING' });

    // As the worker records it: the key under the office, rendered for the current state.
    const row = await raw.platformPayment.findUniqueOrThrow({ where: { id: paid.id } });
    await raw.platformPayment.update({
      where: { id: paid.id },
      data: {
        pdfStorageKey: `${id}/receipts/${paid.id as string}/r.pdf`,
        pdfLanguage: 'EN',
        pdfRenderedFor: row.updatedAt,
        updatedAt: row.updatedAt,
      },
    });
    const ready = await http().get(url).set(auth).expect(200);
    expect(ready.body.data).toMatchObject({ status: 'READY', expiresIn: 300 });
    expect(ready.body.data.downloadUrl).toContain(`${id}/receipts/`);
    expect(
      await raw.platformAuditLog.count({
        where: { adminId, action: 'PAYMENT_RECEIPT_DOWNLOADED', entityId: paid.id },
      }),
    ).toBe(1);
    await http().get(`/api/v1/admin/payments/${randomUUID()}/receipt`).set(auth).expect(404);
  });

  it('should not let the app role delete a payment', async () => {
    const [grant] = await raw.$queryRaw<{ allowed: boolean | null }[]>`
      SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexlegtiq_app')
        THEN has_table_privilege('nexlegtiq_app', 'platform_payments', 'DELETE') END AS allowed`;
    // Null where the role does not exist (a bare local database); false wherever it does.
    expect(grant?.allowed).not.toBe(true);
  });

  it('should refuse every payment route without an admin session or with an office token', async () => {
    const id = await office();
    const paid = (await record(id, payment({ emailOffice: false })).expect(201)).body.data;
    const officeToken = bearerFor(app.get(JwtService), {
      userId: randomUUID(),
      officeId: id,
      role: 'OFFICE_MANAGER',
    });
    const calls = [
      () => http().get(`/api/v1/admin/offices/${id}/payments`),
      () => http().post(`/api/v1/admin/offices/${id}/payments`).send(payment()),
      () =>
        http()
          .post(`/api/v1/admin/payments/${paid.id as string}/void`)
          .send({ reason: 'nope' }),
      () => http().get(`/api/v1/admin/payments/${paid.id as string}/receipt`),
    ];
    for (const call of calls) {
      await call().expect(401);
      await call().set(officeToken).expect(401);
    }
    const row = await raw.platformPayment.findUniqueOrThrow({ where: { id: paid.id } });
    expect(row.voidedAt).toBeNull();
  });

  it('should keep the payer as recorded, refuse a void without a reason and number on after a void', async () => {
    const id = await office();
    const first = (await record(id, payment({ emailOffice: false })).expect(201)).body.data;
    await raw.office.update({ where: { id }, data: { name: 'Renamed office' } });
    const row = await raw.platformPayment.findUniqueOrThrow({ where: { id: first.id } });
    expect(row.payerName).toMatch(/^pay-/);
    expect(row.payerEmail).toBe('office@example.test');

    for (const reason of ['', '   ', 'x'.repeat(501)]) {
      const res = await http()
        .post(`/api/v1/admin/payments/${first.id as string}/void`)
        .set(auth)
        .send({ reason })
        .expect(400);
      expect(res.body.error.details[0].field).toBe('reason');
    }
    await http()
      .post(`/api/v1/admin/payments/${first.id as string}/void`)
      .set(auth)
      .send({ reason: 'recorded twice' })
      .expect(200);
    const second = (await record(id, payment({ emailOffice: false })).expect(201)).body.data;
    expect(second.receiptNumber).not.toBe(first.receiptNumber);
    expect(seq(second.receiptNumber as string)).toBeGreaterThan(seq(first.receiptNumber as string));
    const list = await http().get(`/api/v1/admin/offices/${id}/payments`).set(auth).expect(200);
    const voided = list.body.data.find((p: { id: string }) => p.id === first.id);
    expect(voided.voidedAt).not.toBeNull();
  });

  it('should render the receipt again after a void, the stored one being stale', async () => {
    const id = await office();
    const paid = (await record(id, payment({ emailOffice: false })).expect(201)).body.data;
    const before = await raw.platformPayment.findUniqueOrThrow({ where: { id: paid.id } });
    await raw.platformPayment.update({
      where: { id: paid.id },
      data: {
        pdfStorageKey: `${id}/receipts/${paid.id as string}/r.pdf`,
        pdfLanguage: 'EN',
        pdfRenderedFor: before.updatedAt,
        updatedAt: before.updatedAt,
      },
    });
    const url = `/api/v1/admin/payments/${paid.id as string}/receipt`;
    await http().get(`${url}?language=EN`).set(auth).expect(200);
    await http().get(`${url}?language=AR`).set(auth).expect(202);
    await http()
      .post(`/api/v1/admin/payments/${paid.id as string}/void`)
      .set(auth)
      .send({ reason: 'wrong office' })
      .expect(200);
    await http().get(`${url}?language=EN`).set(auth).expect(202);
  });
});
