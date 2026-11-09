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

/** D-154 on real PostgreSQL: who sees, writes and changes a file's notes, and confidential bodies at rest. */
describe('file notes (HTTP + PostgreSQL)', () => {
  let app: NestExpressApplication;
  let raw: PrismaClient;
  let jwt: JwtService;
  let manager: Person;
  let lawyer: Person;
  let senior: Person;
  let paralegal: Person;
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
    return async (role: Role, fullName: string = role): Promise<Person> => {
      const user = await raw.user.create({
        data: {
          officeId: row.id,
          fullName,
          email: `nt-${randomUUID()}@example.test`,
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
    const inA = await office('Notes office A');
    manager = await inA('OFFICE_MANAGER', 'Layla Manager');
    lawyer = await inA('LAWYER', 'Omar Lawyer');
    senior = await inA('SENIOR_LAWYER', 'Hana Senior');
    paralegal = await inA('PARALEGAL', 'Rana Paralegal');
    other = await (await office('Notes office B'))('OFFICE_MANAGER');
    const file = await raw.legalFile.create({
      data: {
        officeId: manager.officeId,
        fileNumber: `NT-${randomUUID()}`,
        title: 'Rent claim',
        fileType: 'LITIGATION',
        responsibleLawyerId: lawyer.userId,
        responsibleParalegalId: paralegal.userId,
        jurisdiction: 'PALESTINE',
        currency: 'ILS',
      },
    });
    fileId = file.id;
  }, 60_000);

  afterAll(async () => {
    if (raw) {
      const where = { officeId: { in: officeIds } };
      await raw.fileNote.deleteMany({ where });
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

  const notes = (person: Person) =>
    http().get(`/api/v1/cases/${fileId}/notes`).set(bearerFor(jwt, person));
  const add = (person: Person, body: object) =>
    http().post(`/api/v1/cases/${fileId}/notes`).set(bearerFor(jwt, person)).send(body);
  const patch = (person: Person, id: string, body: object) =>
    http().patch(`/api/v1/cases/${fileId}/notes/${id}`).set(bearerFor(jwt, person)).send(body);

  it('should encrypt confidential notes and show them only to the office manager and the file people', async () => {
    const xss = '<img src=x onerror=alert(1)> **bold**';
    const plain = await add(lawyer, { body: xss, pinned: true });
    expect(plain.status).toBe(201);
    // Stored and returned as written: the app renders it as text, never as HTML.
    expect(plain.body.data).toMatchObject({ body: xss, pinned: true, canEdit: true });
    const secret = await add(lawyer, { body: 'Client admitted the debt', isConfidential: true });
    expect(secret.status).toBe(201);
    const stored = await raw.fileNote.findUniqueOrThrow({ where: { id: secret.body.data.id } });
    expect(stored.body).toMatch(/^v1:/);
    expect(stored.body).not.toContain('debt');

    expect((await notes(manager)).body.data.map((n: { body: string }) => n.body)).toEqual([
      xss,
      'Client admitted the debt',
    ]);
    expect((await notes(paralegal)).body.data).toHaveLength(2);
    // A senior lawyer sees every file, but not its confidential notes when not on it (D-154).
    const seen = (await notes(senior)).body.data;
    expect(seen.map((n: { id: string }) => n.id)).toEqual([plain.body.data.id]);
    expect((await add(senior, { body: 'x', isConfidential: true })).status).toBe(403);
    expect((await patch(senior, secret.body.data.id, { pinned: true })).status).toBe(404);
    expect((await notes(other)).status).toBe(404);
  });

  it('should let authors change their notes, OM/SL anyone’s, and nobody on an archived file', async () => {
    const note = (await add(lawyer, { body: 'Draft strategy' })).body.data as { id: string };
    expect((await patch(paralegal, note.id, { body: 'Mine now' })).status).toBe(403);
    expect((await patch(senior, note.id, { pinned: true })).body.data).toMatchObject({
      pinned: true,
      body: 'Draft strategy',
    });
    const secret = await patch(lawyer, note.id, { isConfidential: true });
    expect(secret.body.data).toMatchObject({ isConfidential: true, body: 'Draft strategy' });
    expect((await raw.fileNote.findUniqueOrThrow({ where: { id: note.id } })).body).toMatch(/^v1:/);
    expect((await patch(lawyer, note.id, {})).status).toBe(400);
    expect(
      (
        await http()
          .delete(`/api/v1/cases/${fileId}/notes/${note.id}`)
          .set(bearerFor(jwt, paralegal))
      ).status,
    ).toBe(403);
    await raw.legalFile.update({ where: { id: fileId }, data: { status: 'ARCHIVED' } });
    expect((await add(lawyer, { body: 'Too late' })).body.error.code).toBe('BIZ-007');
    await raw.legalFile.update({ where: { id: fileId }, data: { status: 'OPEN' } });
    expect(
      (await http().delete(`/api/v1/cases/${fileId}/notes/${note.id}`).set(bearerFor(jwt, lawyer)))
        .status,
    ).toBe(204);
  });
});
