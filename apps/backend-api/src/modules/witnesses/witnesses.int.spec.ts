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

/** D-163 on real PostgreSQL: witnesses and statements follow the file's access, refs stay on the file, text is indexed. */
describe('witnesses and statements (HTTP + PostgreSQL)', () => {
  let app: NestExpressApplication;
  let raw: PrismaClient;
  let jwt: JwtService;
  let manager: Person;
  let lawyer: Person;
  let trainee: Person;
  let other: Person;
  let fileId: string;
  let otherFileId: string;
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
          email: `wt-${randomUUID()}@example.test`,
          passwordHash: '!',
          role,
        },
      });
      return { userId: user.id, officeId: row.id, role };
    };
  }

  const newFile = (officeId: string, lawyerId: string) =>
    raw.legalFile.create({
      data: {
        officeId,
        fileNumber: `WT-${randomUUID()}`,
        title: 'Labour claim',
        fileType: 'LITIGATION',
        responsibleLawyerId: lawyerId,
        jurisdiction: 'PALESTINE',
        currency: 'ILS',
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
    const inA = await office('Witness office A');
    manager = await inA('OFFICE_MANAGER');
    lawyer = await inA('LAWYER');
    trainee = await inA('TRAINEE');
    other = await (await office('Witness office B'))('OFFICE_MANAGER');
    fileId = (await newFile(manager.officeId, lawyer.userId)).id;
    otherFileId = (await newFile(manager.officeId, lawyer.userId)).id;
  }, 60_000);

  afterAll(async () => {
    if (raw) {
      const where = { officeId: { in: officeIds } };
      await raw.witnessStatement.deleteMany({ where });
      await raw.witness.deleteMany({ where });
      await raw.session.deleteMany({ where });
      await raw.caseTimelineEvent.deleteMany({ where });
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

  const as = (person: Person) => ({
    get: (path: string) => http().get(`/api/v1/${path}`).set(bearerFor(jwt, person)),
    post: (path: string, body: object) =>
      http().post(`/api/v1/${path}`).set(bearerFor(jwt, person)).send(body),
    patch: (path: string, body: object) =>
      http().patch(`/api/v1/${path}`).set(bearerFor(jwt, person)).send(body),
    delete: (path: string) => http().delete(`/api/v1/${path}`).set(bearerFor(jwt, person)),
  });

  it('should keep witnesses and statements on their file, with plain text stored as written and indexed', async () => {
    const created = await as(lawyer).post(`cases/${fileId}/witnesses`, {
      fullName: 'سامي الخطيب',
      isExpert: true,
      expertiseArea: 'Engineering',
      phone: '+970599123456',
    });
    expect(created.status).toBe(201);
    const witnessId = created.body.data.id as string;
    expect(created.body.data).toMatchObject({ isExpert: true, statementCount: 0 });

    const xss = '<script>alert(1)</script> شهد بأن العامل كان يعمل ساعات إضافية';
    const statement = await as(lawyer).post(`witnesses/${witnessId}/statements`, {
      statementDate: '2026-01-15',
      text: xss,
      isUnderOath: true,
    });
    expect(statement.status).toBe(201);
    expect(statement.body.data).toMatchObject({
      text: xss,
      isUnderOath: true,
      recordedBy: { id: lawyer.userId },
      session: null,
    });

    // A hearing of another file of the same office is refused.
    const foreign = await raw.session.create({
      data: {
        officeId: manager.officeId,
        fileId: otherFileId,
        startsAt: new Date(),
        attendingLawyerId: lawyer.userId,
        createdById: lawyer.userId,
        reminderDays: [],
      },
    });
    const refused = await as(lawyer).post(`witnesses/${witnessId}/statements`, {
      statementDate: '2026-01-16',
      text: 'Second',
      sessionId: foreign.id,
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error.details).toEqual([
      expect.objectContaining({ field: 'sessionId', message: 'validation.unknownSession' }),
    ]);
    const future = await as(lawyer).post(`witnesses/${witnessId}/statements`, {
      statementDate: '2999-01-01',
      text: 'Later',
    });
    expect(future.body.error.details[0]).toMatchObject({ message: 'validation.futureDate' });

    // Timeline event (no testimony in it), audit row without the text, search vector filled.
    const event = await raw.caseTimelineEvent.findFirstOrThrow({
      where: { fileId, eventType: 'WITNESS_STATEMENT_ADDED' },
    });
    expect(JSON.stringify(event.payload)).not.toContain('ساعات');
    const audit = await raw.auditLog.findFirstOrThrow({
      where: { entityType: 'WitnessStatement', entityId: statement.body.data.id },
    });
    expect(JSON.stringify(audit.newValues)).not.toContain('ساعات');
    const [hit] = await raw.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM witness_statements
      WHERE id = ${statement.body.data.id}::uuid
        AND search_vector_simple @@ to_tsquery('simple', nlq_normalize_ar('العامل'))`;
    expect(Number(hit?.n)).toBe(1);

    expect((await as(manager).get(`witnesses/${witnessId}/statements`)).body.data).toHaveLength(1);
    const edited = await as(lawyer).patch(
      `witnesses/${witnessId}/statements/${statement.body.data.id}`,
      { text: 'Corrected' },
    );
    expect(edited.body.data.text).toBe('Corrected');
    expect((await as(manager).get(`cases/${fileId}/witnesses`)).body.data[0]).toMatchObject({
      statementCount: 1,
    });
  });

  it('should refuse writes without edit rights, hide everything from another office and block archived files', async () => {
    const witness = (await as(lawyer).post(`cases/${fileId}/witnesses`, { fullName: 'Nour' })).body
      .data as { id: string };
    expect((await as(trainee).post(`cases/${fileId}/witnesses`, { fullName: 'X' })).status).toBe(
      403,
    );
    expect(
      (
        await as(trainee).post(`witnesses/${witness.id}/statements`, {
          statementDate: '2026-01-01',
          text: 'x',
        })
      ).status,
    ).toBe(403);

    expect((await as(other).get(`cases/${fileId}/witnesses`)).status).toBe(404);
    expect((await as(other).get(`witnesses/${witness.id}/statements`)).status).toBe(404);
    expect(
      (await as(other).patch(`cases/${fileId}/witnesses/${witness.id}`, { fullName: 'Y' })).status,
    ).toBe(404);
    expect((await as(other).delete(`cases/${fileId}/witnesses/${witness.id}`)).status).toBe(404);
    // The same witness addressed through another file of its own office is not found either.
    expect((await as(lawyer).delete(`cases/${otherFileId}/witnesses/${witness.id}`)).status).toBe(
      404,
    );

    await raw.legalFile.update({ where: { id: fileId }, data: { status: 'ARCHIVED' } });
    expect(
      (await as(lawyer).post(`cases/${fileId}/witnesses`, { fullName: 'Late' })).body.error.code,
    ).toBe('BIZ-007');
    await raw.legalFile.update({ where: { id: fileId }, data: { status: 'OPEN' } });
    expect((await as(lawyer).delete(`cases/${fileId}/witnesses/${witness.id}`)).status).toBe(204);
  });
});
