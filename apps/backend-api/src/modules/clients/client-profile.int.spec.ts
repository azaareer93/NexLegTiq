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

/** MVP-55 on real PostgreSQL: a client's notes (D-168), documents across its files and invoice totals. */
describe('client profile (HTTP + PostgreSQL)', () => {
  let app: NestExpressApplication;
  let raw: PrismaClient;
  let jwt: JwtService;
  let manager: Person;
  let lawyer: Person;
  let senior: Person;
  let trainee: Person;
  let other: Person;
  let clientId: string;
  let openFileId: string;
  let secretFileId: string;
  const officeIds: string[] = [];
  const savedEnv = { ...process.env };
  const http = () => request(app.getHttpServer());

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
          email: `cp-${randomUUID()}@example.test`,
          passwordHash: '!',
          role,
        },
      });
      return { userId: user.id, officeId: row.id, role };
    };
  }

  async function file(isConfidential: boolean) {
    const { officeId } = manager;
    const row = await raw.legalFile.create({
      data: {
        officeId,
        fileNumber: `CP-${randomUUID()}`,
        title: isConfidential ? 'Secret matter' : 'Rent claim',
        fileType: 'LITIGATION',
        responsibleLawyerId: lawyer.userId,
        jurisdiction: 'PALESTINE',
        currency: 'ILS',
        isConfidential,
      },
    });
    await raw.fileClient.create({ data: { officeId, fileId: row.id, clientId, isPrimary: true } });
    await raw.document.create({
      data: {
        officeId,
        fileId: row.id,
        name: `${row.title}.pdf`,
        originalFilename: `${row.title}.pdf`,
        mimeType: 'application/pdf',
        sizeBytes: 10n,
        checksumSha256: 'c'.repeat(64),
        storageKey: `${officeId}/${row.id}/${randomUUID()}.pdf`,
        status: 'READY',
        uploadedById: manager.userId,
      },
    });
    return row.id;
  }

  const invoice = (
    status: 'DRAFT' | 'SENT' | 'OVERDUE' | 'PAID',
    total: string,
    currency = 'ILS',
  ) =>
    raw.invoice.create({
      data: {
        officeId: manager.officeId,
        clientId,
        fileId: openFileId,
        status,
        invoiceNumber: status === 'DRAFT' ? null : `INV-${randomUUID()}`,
        currency,
        issueDate: status === 'DRAFT' ? null : new Date('2026-11-01'),
        dueDate: status === 'DRAFT' ? null : new Date('2026-12-01'),
        subtotal: total,
        taxRatePercent: '0',
        taxAmount: '0',
        total,
        paidAt: status === 'PAID' ? new Date() : null,
        createdById: manager.userId,
      },
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
    // unscoped: fixtures for two offices and checks across them.
    raw = app.get(PrismaService).unscoped();
    jwt = app.get(JwtService);
    const inA = await office('Client profile office A');
    manager = await inA('OFFICE_MANAGER');
    lawyer = await inA('LAWYER');
    senior = await inA('SENIOR_LAWYER');
    trainee = await inA('TRAINEE');
    other = await (await office('Client profile office B'))('OFFICE_MANAGER');
    clientId = (
      await raw.client.create({
        data: { officeId: manager.officeId, clientType: 'INDIVIDUAL', displayName: 'Nour Haddad' },
      })
    ).id;
    openFileId = await file(false);
    secretFileId = await file(true);
  }, 60_000);

  afterAll(async () => {
    if (raw) {
      const where = { officeId: { in: officeIds } };
      await raw.fileNote.deleteMany({ where });
      await raw.invoice.deleteMany({ where });
      await raw.document.deleteMany({ where });
      await raw.fileClient.deleteMany({ where });
      await raw.legalFile.deleteMany({ where });
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

  const get = (person: Person, path: string) =>
    http().get(`/api/v1/${path}`).set(bearerFor(jwt, person));
  const addNote = (person: Person, body: object) =>
    http().post(`/api/v1/clients/${clientId}/notes`).set(bearerFor(jwt, person)).send(body);
  const bodies = async (person: Person) =>
    (await get(person, `clients/${clientId}/notes`)).body.data.map((n: { body: string }) => n.body);

  it('should encrypt confidential client notes and show them to the office manager and their author only', async () => {
    const plain = await addNote(senior, { body: 'Prefers calls in the morning', pinned: true });
    expect(plain.status).toBe(201);
    const secret = await addNote(lawyer, { body: 'Owes the bank', isConfidential: true });
    expect(secret.status).toBe(201);
    const stored = await raw.fileNote.findUniqueOrThrow({ where: { id: secret.body.data.id } });
    expect(stored).toMatchObject({ clientId, fileId: null });
    expect(stored.body).toMatch(/^v1:/);
    expect(stored.body).not.toContain('bank');

    expect(await bodies(lawyer)).toEqual(['Prefers calls in the morning', 'Owes the bank']);
    expect(await bodies(manager)).toEqual(['Prefers calls in the morning', 'Owes the bank']);
    expect(await bodies(senior)).toEqual(['Prefers calls in the morning']);
    // Hidden from the senior lawyer, so not theirs to change either.
    const patch = await http()
      .patch(`/api/v1/clients/${clientId}/notes/${secret.body.data.id}`)
      .set(bearerFor(jwt, senior))
      .send({ pinned: true });
    expect(patch.status).toBe(404);
    // Nor may a colleague hide the senior lawyer's plain note from them (D-168).
    const hide = await http()
      .patch(`/api/v1/clients/${clientId}/notes/${plain.body.data.id}`)
      .set(bearerFor(jwt, lawyer))
      .send({ isConfidential: true });
    expect(hide.status).toBe(403);
    // A client note never shows on its files' notes.
    expect((await get(manager, `cases/${openFileId}/notes`)).body.data).toEqual([]);
  });

  it('should refuse client notes without manage:clients and across offices', async () => {
    expect((await get(trainee, `clients/${clientId}/notes`)).status).toBe(403);
    expect((await get(other, `clients/${clientId}/notes`)).status).toBe(404);
    expect((await addNote(other, { body: 'x' })).status).toBe(404);
    expect((await get(manager, `clients/${randomUUID()}/notes`)).status).toBe(404);
  });

  it("should list the documents of the client's files the caller may see, with their file", async () => {
    const names = async (person: Person) =>
      (await get(person, `clients/${clientId}/documents`)).body.data.map(
        (d: { name: string; file: { id: string } }) => [d.name, d.file.id],
      );
    expect(await names(manager)).toEqual(
      expect.arrayContaining([
        ['Rent claim.pdf', openFileId],
        ['Secret matter.pdf', secretFileId],
      ]),
    );
    // A senior lawyer sees every file but a confidential one only when on it (D-096).
    expect(await names(senior)).toEqual([['Rent claim.pdf', openFileId]]);
    expect((await get(other, `clients/${clientId}/documents`)).status).toBe(404);
    expect((await get(trainee, `clients/${clientId}/documents`)).status).toBe(403);
  });

  it("should total the client's billed and outstanding invoices per currency, never drafts", async () => {
    await invoice('SENT', '100');
    await invoice('OVERDUE', '50.5');
    await invoice('PAID', '20');
    await invoice('DRAFT', '999');
    await invoice('SENT', '7.125', 'JOD');
    const res = await get(manager, `invoices/summary?clientId=${clientId}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      billed: [
        { currency: 'ILS', amount: '170.50', count: 3 },
        { currency: 'JOD', amount: '7.125', count: 1 },
      ],
      outstanding: [
        { currency: 'ILS', amount: '150.50', count: 2 },
        { currency: 'JOD', amount: '7.125', count: 1 },
      ],
    });
    expect((await get(other, `invoices/summary?clientId=${clientId}`)).body.data).toEqual({
      billed: [],
      outstanding: [],
    });
    expect((await get(trainee, `invoices/summary?clientId=${clientId}`)).status).toBe(403);
    expect((await get(manager, 'invoices/summary?clientId=nope')).status).toBe(400);
  });
});
