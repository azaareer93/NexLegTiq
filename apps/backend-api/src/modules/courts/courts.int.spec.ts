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

type Delegate = { deleteMany(args: unknown): Promise<unknown> };
interface SeededUser {
  readonly userId: string;
  readonly officeId: string;
  readonly role: Role;
}
type Body<T = Record<string, unknown>> = { data: T; error?: { code: string; details?: unknown } };

/** MVP-66 through HTTP on real PostgreSQL: platform and office courts, judges, prosecutors, files' court and judge. */
describe('courts API (HTTP + PostgreSQL)', () => {
  let app: NestExpressApplication;
  let raw: PrismaClient;
  let jwt: JwtService;
  const officeIds: string[] = [];
  const platformCourtIds: string[] = [];
  const savedEnv = { ...process.env };
  const tag = randomUUID().slice(0, 8);
  let manager: SeededUser;
  let trainee: SeededUser;
  let other: SeededUser;
  let platformCourt: string;
  let platformJudge: string;

  const http = () => request(app.getHttpServer());
  const as = (user: SeededUser) => bearerFor(jwt, user);

  async function seedOffice(name: string): Promise<string> {
    const office = await raw.office.create({ data: { name, settings: { create: {} } } });
    officeIds.push(office.id);
    return office.id;
  }

  async function seedUser(officeId: string, role: Role): Promise<SeededUser> {
    const user = await raw.user.create({
      data: {
        officeId,
        fullName: role,
        email: `courts-${randomUUID()}@example.test`,
        passwordHash: '!',
        role,
      },
    });
    return { userId: user.id, officeId, role };
  }

  async function createCourt(user: SeededUser, body: Record<string, unknown>): Promise<string> {
    const res = await http()
      .post('/api/v1/courts')
      .set(as(user))
      .send({ courtType: 'MAGISTRATE', ...body })
      .expect(201);
    return (res.body as Body<{ id: string }>).data.id;
  }

  async function createJudge(user: SeededUser, courtId: string, fullName: string) {
    const res = await http()
      .post(`/api/v1/courts/${courtId}/judges`)
      .set(as(user))
      .send({ fullName })
      .expect(201);
    return (res.body as Body<{ id: string }>).data.id;
  }

  async function newCase(body: Record<string, unknown>, status: number) {
    const client = await raw.client.create({
      data: { officeId: manager.officeId, clientType: 'INDIVIDUAL', displayName: 'Client' },
    });
    return http()
      .post('/api/v1/cases')
      .set(as(manager))
      .send({
        title: 'Court case',
        fileType: 'LITIGATION',
        clientIds: [client.id],
        primaryClientId: client.id,
        responsibleLawyerId: manager.userId,
        ...body,
      })
      .expect(status);
  }

  const courtIds = async (user: SeededUser, query = '') =>
    (
      (await http().get(`/api/v1/courts?limit=100${query}`).set(as(user)).expect(200)).body as Body<
        { id: string }[]
      >
    ).data.map((row) => row.id);

  beforeAll(async () => {
    Object.assign(process.env, integrationEnv(), { EMAIL_VERIFICATION_ENFORCED: 'false' });
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = module.createNestApplication<NestExpressApplication>({ bufferLogs: true });
    configureApp(app);
    await app.init();
    // unscoped: test fixtures across two offices and platform rows.
    raw = app.get(PrismaService).unscoped();
    jwt = app.get(JwtService);
    const officeId = await seedOffice('Courts office');
    manager = await seedUser(officeId, 'OFFICE_MANAGER');
    trainee = await seedUser(officeId, 'TRAINEE');
    other = await seedUser(await seedOffice('Other office'), 'OFFICE_MANAGER');
    const court = await raw.court.create({
      data: {
        jurisdiction: 'PALESTINE',
        courtType: 'FIRST_INSTANCE',
        nameAr: `محكمة بداية ${tag}`,
        nameEn: `Test First Instance ${tag}`,
      },
    });
    platformCourtIds.push(court.id);
    platformCourt = court.id;
    platformJudge = (await raw.judge.create({ data: { courtId: court.id, fullName: 'Platform' } }))
      .id;
  }, 60_000);

  afterAll(async () => {
    if (raw) {
      const where = { officeId: { in: officeIds } };
      for (const model of [...TENANT_MODELS].filter((name) => name !== 'User').reverse()) {
        const name = model.charAt(0).toLowerCase() + model.slice(1);
        await (raw as unknown as Record<string, Delegate>)[name]?.deleteMany({ where });
      }
      await raw.judge.deleteMany({ where });
      await raw.judge.deleteMany({ where: { courtId: { in: platformCourtIds } } });
      await raw.court.deleteMany({ where });
      await raw.court.deleteMany({ where: { id: { in: platformCourtIds } } });
      await raw.user.deleteMany({ where });
      await raw.office.deleteMany({ where: { id: { in: officeIds } } });
    }
    await app?.close();
    process.env = savedEnv;
  });

  describe('courts', () => {
    it('should list platform courts and the office own, never another office courts', async () => {
      const mine = await createCourt(manager, { nameAr: `صلح ${tag}`, city: 'دورا' });
      const theirs = await createCourt(other, { nameAr: `صلح آخر ${tag}` });
      const ids = await courtIds(manager, `&search=${tag}`);
      expect(ids).toEqual(expect.arrayContaining([platformCourt, mine]));
      expect(ids).not.toContain(theirs);
      expect(await courtIds(manager, `&search=${encodeURIComponent('دورا')}`)).toContain(mine);
      expect(await courtIds(manager, '&jurisdiction=JORDAN')).not.toContain(mine);
      await http().get(`/api/v1/courts/${theirs}`).set(as(manager)).expect(404);
    });

    it('should default the jurisdiction to the office one and flag platform rows', async () => {
      const id = await createCourt(manager, { nameAr: `محكمة ${tag}-j` });
      const own = (await http().get(`/api/v1/courts/${id}`).set(as(manager)).expect(200))
        .body as Body<{ jurisdiction: string; isPlatform: boolean }>;
      expect(own.data).toMatchObject({ jurisdiction: 'PALESTINE', isPlatform: false });
      const platform = (
        await http().get(`/api/v1/courts/${platformCourt}`).set(as(manager)).expect(200)
      ).body as Body<{ isPlatform: boolean }>;
      expect(platform.data.isPlatform).toBe(true);
    });

    it('should refuse to edit or delete a platform court (403) and another office court (404)', async () => {
      await http()
        .patch(`/api/v1/courts/${platformCourt}`)
        .set(as(manager))
        .send({ city: 'X' })
        .expect(403);
      await http().delete(`/api/v1/courts/${platformCourt}`).set(as(manager)).expect(403);
      const theirs = await createCourt(other, { nameAr: `لهم ${tag}` });
      await http()
        .patch(`/api/v1/courts/${theirs}`)
        .set(as(manager))
        .send({ city: 'X' })
        .expect(404);
      await http().delete(`/api/v1/courts/${theirs}`).set(as(manager)).expect(404);
      expect((await raw.court.findUniqueOrThrow({ where: { id: platformCourt } })).city).toBeNull();
    });

    it('should edit an office court with an audit row of the changed fields only', async () => {
      const id = await createCourt(manager, { nameAr: `تعديل ${tag}`, city: 'نابلس' });
      const res = await http()
        .patch(`/api/v1/courts/${id}`)
        .set(as(manager))
        .send({ city: 'جنين', nameAr: `تعديل ${tag}` })
        .expect(200);
      expect((res.body as Body<{ city: string }>).data.city).toBe('جنين');
      const audit = await raw.auditLog.findFirstOrThrow({
        where: { entityType: 'Court', entityId: id, action: 'UPDATE' },
      });
      expect(audit.oldValues).toEqual({ city: 'نابلس' });
      expect(audit.newValues).toEqual({ city: 'جنين' });
    });

    it('should refuse a duplicate Arabic name in the office and jurisdiction (409)', async () => {
      await createCourt(manager, { nameAr: `مكرر ${tag}` });
      await http()
        .post('/api/v1/courts')
        .set(as(manager))
        .send({ courtType: 'MAGISTRATE', nameAr: `مكرر ${tag}` })
        .expect(409);
    });

    it('should not let a trainee add courts, judges or prosecutors (403) but let them read', async () => {
      await http()
        .post('/api/v1/courts')
        .set(as(trainee))
        .send({ courtType: 'MAGISTRATE', nameAr: 'x' })
        .expect(403);
      await http()
        .post(`/api/v1/courts/${platformCourt}/judges`)
        .set(as(trainee))
        .send({ fullName: 'x' })
        .expect(403);
      await http().post('/api/v1/prosecutors').set(as(trainee)).send({ fullName: 'x' }).expect(403);
      await http().get('/api/v1/courts').set(as(trainee)).expect(200);
      await http().get(`/api/v1/courts/${platformCourt}/judges`).set(as(trainee)).expect(200);
    });

    it('should validate the body (400 VAL-001)', async () => {
      await http()
        .post('/api/v1/courts')
        .set(as(manager))
        .send({ courtType: 'NOPE', nameAr: '' })
        .expect(400);
    });
  });

  describe('judges', () => {
    it('should add an office judge to a platform court, visible to that office only', async () => {
      const mine = await createJudge(manager, platformCourt, `قاضي ${tag}`);
      const theirs = await createJudge(other, platformCourt, `قاضيهم ${tag}`);
      const list = (
        await http().get(`/api/v1/courts/${platformCourt}/judges`).set(as(manager)).expect(200)
      ).body as Body<{ id: string; isPlatform: boolean }[]>;
      const ids = list.data.map((judge) => judge.id);
      expect(ids).toEqual(expect.arrayContaining([platformJudge, mine]));
      expect(ids).not.toContain(theirs);
      await http()
        .patch(`/api/v1/courts/${platformCourt}/judges/${theirs}`)
        .set(as(manager))
        .send({ isActive: false })
        .expect(404);
      await http()
        .patch(`/api/v1/courts/${platformCourt}/judges/${platformJudge}`)
        .set(as(manager))
        .send({ isActive: false })
        .expect(403);
      await http()
        .patch(`/api/v1/courts/${platformCourt}/judges/${mine}`)
        .set(as(manager))
        .send({ isActive: false })
        .expect(200);
    });

    it('should not add a judge to another office court (404)', async () => {
      const theirs = await createCourt(other, { nameAr: `محكمتهم ${tag}` });
      await http()
        .post(`/api/v1/courts/${theirs}/judges`)
        .set(as(manager))
        .send({ fullName: 'x' })
        .expect(404);
    });

    it('should refuse, in the database, a judge at a court its office cannot see', async () => {
      const theirs = await createCourt(other, { nameAr: `قاعدة ${tag}` });
      await expect(
        raw.judge.create({ data: { officeId: manager.officeId, courtId: theirs, fullName: 'x' } }),
      ).rejects.toThrow();
      await expect(
        raw.judge.create({ data: { courtId: theirs, fullName: 'x' } }),
      ).rejects.toThrow();
    });
  });

  describe('a file court and judge', () => {
    it('should open a file at a platform court with its judge and show them', async () => {
      const res = await newCase({ courtId: platformCourt, judgeId: platformJudge }, 201);
      const file = (res.body as Body<{ court: { id: string }; judge: { id: string } }>).data;
      expect(file.court.id).toBe(platformCourt);
      expect(file.judge.id).toBe(platformJudge);
    });

    it('should refuse another office court, or a judge of another court (400)', async () => {
      const theirs = await createCourt(other, { nameAr: `ملف ${tag}` });
      const mine = await createCourt(manager, { nameAr: `ملفي ${tag}` });
      const bad = await newCase({ courtId: theirs }, 400);
      expect(JSON.stringify(bad.body)).toContain('validation.unknownCourt');
      const wrongJudge = await newCase({ courtId: mine, judgeId: platformJudge }, 400);
      expect(JSON.stringify(wrongJudge.body)).toContain('validation.unknownJudge');
    });

    it('should drop the judge when the court changes, and block deleting a court in use (422)', async () => {
      const mine = await createCourt(manager, { nameAr: `استخدام ${tag}` });
      const created = await newCase({ courtId: platformCourt, judgeId: platformJudge }, 201);
      const id = (created.body as Body<{ id: string }>).data.id;
      const res = await http()
        .patch(`/api/v1/cases/${id}`)
        .set(as(manager))
        .send({ courtId: mine })
        .expect(200);
      expect(res.body).toMatchObject({ data: { court: { id: mine }, judge: null } });
      const blocked = await http().delete(`/api/v1/courts/${mine}`).set(as(manager)).expect(422);
      expect((blocked.body as Body).error?.code).toBe('BIZ-011');
      await http()
        .patch(`/api/v1/cases/${id}`)
        .set(as(manager))
        .send({ courtId: null })
        .expect(200);
      await http().delete(`/api/v1/courts/${mine}`).set(as(manager)).expect(204);
    });

    it('should refuse, in the database, a file naming a court its office cannot see', async () => {
      const theirs = await createCourt(other, { nameAr: `قاعدة ملف ${tag}` });
      await expect(
        raw.legalFile.create({
          data: {
            officeId: manager.officeId,
            fileNumber: `CT-${randomUUID()}`,
            title: 'x',
            fileType: 'LITIGATION',
            responsibleLawyerId: manager.userId,
            jurisdiction: 'PALESTINE',
            currency: 'ILS',
            courtId: theirs,
          },
        }),
      ).rejects.toThrow();
    });
  });

  describe('prosecutors', () => {
    it('should create, search, edit and delete a prosecutor of the office', async () => {
      const created = await http()
        .post('/api/v1/prosecutors')
        .set(as(manager))
        .send({ fullName: `وكيل ${tag}`, officeName: 'نيابة رام الله', phone: '+970 2 123 4567' })
        .expect(201);
      const id = (created.body as Body<{ id: string }>).data.id;
      const list = (
        await http().get(`/api/v1/prosecutors?search=${tag}`).set(as(manager)).expect(200)
      ).body as Body<{ id: string }[]>;
      expect(list.data.map((row) => row.id)).toEqual([id]);
      await http()
        .patch(`/api/v1/prosecutors/${id}`)
        .set(as(manager))
        .send({ officeName: null })
        .expect(200);
      await http().get(`/api/v1/prosecutors/${id}`).set(as(other)).expect(404);
      await http().delete(`/api/v1/prosecutors/${id}`).set(as(manager)).expect(204);
      await http().get(`/api/v1/prosecutors/${id}`).set(as(manager)).expect(404);
    });
  });
});
