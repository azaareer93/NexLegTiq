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
type Body<T = Record<string, unknown>> = { data: T; error?: { code: string; details?: unknown } };

/**
 * MVP-66 through HTTP on real PostgreSQL: courts, judges, prosecutors, files' court and judge. Since MVP-167 (D-266) an
 * office reads the active platform courts of its country and keeps its legacy office courts read-only.
 */
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
    const office = await raw.office.create({
      data: { name, settings: { create: {} }, subscriptions: liveSubscription() },
    });
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

  /** An office's own court from before D-266 (offices can no longer add one through the API). */
  async function officeCourt(user: SeededUser, nameAr: string): Promise<string> {
    const court = await raw.court.create({
      data: { officeId: user.officeId, jurisdiction: 'PALESTINE', courtType: 'MAGISTRATE', nameAr },
    });
    return court.id;
  }

  async function platformCourtOf(
    jurisdiction: 'PALESTINE' | 'JORDAN',
    name: string,
    isActive = true,
  ): Promise<string> {
    const court = await raw.court.create({
      data: { jurisdiction, courtType: 'MAGISTRATE', nameAr: name, nameEn: name, isActive },
    });
    platformCourtIds.push(court.id);
    return court.id;
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
    await raw.office.update({ where: { id: officeId }, data: { jurisdiction: 'PALESTINE' } });
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
    it("should list only the active platform courts of the office's country", async () => {
      const mine = await officeCourt(manager, `صلح ${tag}`);
      const theirs = await officeCourt(other, `صلح آخر ${tag}`);
      const jordan = await platformCourtOf('JORDAN', `Amman ${tag}`);
      const retired = await platformCourtOf('PALESTINE', `Retired ${tag}`, false);
      const ids = await courtIds(manager, `&search=${tag}`);
      expect(ids).toContain(platformCourt);
      for (const hidden of [mine, theirs, jordan, retired]) expect(ids).not.toContain(hidden);
      const own = (await http().get(`/api/v1/courts/${mine}`).set(as(manager)).expect(200))
        .body as Body<{ isPlatform: boolean; isActive: boolean }>;
      expect(own.data).toMatchObject({ isPlatform: false, isActive: true });
      await http().get(`/api/v1/courts/${retired}`).set(as(manager)).expect(200);
      await http().get(`/api/v1/courts/${theirs}`).set(as(manager)).expect(404);
    });

    it('should no longer let an office add, edit or delete a court', async () => {
      const mine = await officeCourt(manager, `قديمة ${tag}`);
      await http()
        .post('/api/v1/courts')
        .set(as(manager))
        .send({ courtType: 'MAGISTRATE', nameAr: 'x' })
        .expect(404);
      await http().patch(`/api/v1/courts/${mine}`).set(as(manager)).send({ city: 'X' }).expect(404);
      await http().delete(`/api/v1/courts/${mine}`).set(as(manager)).expect(404);
      expect(await raw.court.count({ where: { id: mine } })).toBe(1);
    });

    it('should not let a trainee add judges or prosecutors (403) but let them read', async () => {
      await http()
        .post(`/api/v1/courts/${platformCourt}/judges`)
        .set(as(trainee))
        .send({ fullName: 'x' })
        .expect(403);
      await http().post('/api/v1/prosecutors').set(as(trainee)).send({ fullName: 'x' }).expect(403);
      await http().get('/api/v1/courts').set(as(trainee)).expect(200);
      await http().get(`/api/v1/courts/${platformCourt}/judges`).set(as(trainee)).expect(200);
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
      const theirs = await officeCourt(other, `محكمتهم ${tag}`);
      await http()
        .post(`/api/v1/courts/${theirs}/judges`)
        .set(as(manager))
        .send({ fullName: 'x' })
        .expect(404);
    });

    it('trigger: should refuse a judge at a court its office cannot see, and moving a judge or court', async () => {
      const theirs = await officeCourt(other, `قاعدة ${tag}`);
      await expect(
        raw.judge.create({ data: { officeId: manager.officeId, courtId: theirs, fullName: 'x' } }),
      ).rejects.toThrow(/cannot see/);
      await expect(raw.judge.create({ data: { courtId: theirs, fullName: 'x' } })).rejects.toThrow(
        /cannot see/,
      );
      const mine = await createJudge(manager, platformCourt, `نقل ${tag}`);
      await expect(
        raw.judge.update({ where: { id: mine }, data: { courtId: theirs } }),
      ).rejects.toThrow(/cannot move/);
      await expect(
        raw.court.update({ where: { id: theirs }, data: { officeId: manager.officeId } }),
      ).rejects.toThrow(/cannot move/);
    });

    it('should refuse to delete a judge named by a file (422), and assign only active judges', async () => {
      const judgeId = await createJudge(manager, platformCourt, `مستخدم ${tag}`);
      await newCase({ courtId: platformCourt, judgeId }, 201);
      const blocked = await http()
        .delete(`/api/v1/courts/${platformCourt}/judges/${judgeId}`)
        .set(as(manager))
        .expect(422);
      expect((blocked.body as Body).error?.code).toBe('BIZ-011');
      await http()
        .patch(`/api/v1/courts/${platformCourt}/judges/${judgeId}`)
        .set(as(manager))
        .send({ isActive: false })
        .expect(200);
      const retired = await newCase({ courtId: platformCourt, judgeId }, 400);
      expect(JSON.stringify(retired.body)).toContain('validation.unknownJudge');
    });
  });

  describe('a file court and judge', () => {
    it('should open a file at a platform court with its judge and show them', async () => {
      const res = await newCase({ courtId: platformCourt, judgeId: platformJudge }, 201);
      const file = (res.body as Body<{ court: { id: string }; judge: { id: string } }>).data;
      expect(file.court.id).toBe(platformCourt);
      expect(file.judge.id).toBe(platformJudge);
    });

    it('should refuse an office court, a deactivated court, or a judge of another court (400)', async () => {
      const theirs = await officeCourt(other, `ملف ${tag}`);
      const mine = await officeCourt(manager, `ملفي ${tag}`);
      const retired = await platformCourtOf('PALESTINE', `Closed ${tag}`, false);
      for (const courtId of [theirs, mine, retired]) {
        const bad = await newCase({ courtId }, 400);
        expect(JSON.stringify(bad.body)).toContain('validation.unknownCourt');
      }
      const judgeElsewhere = await createJudge(manager, mine, `قاضي ملفي ${tag}`);
      const wrongJudge = await newCase({ courtId: platformCourt, judgeId: judgeElsewhere }, 400);
      expect(JSON.stringify(wrongJudge.body)).toContain('validation.unknownJudge');
    });

    it('should keep a legacy court on a file, and drop the judge when the court changes', async () => {
      const mine = await officeCourt(manager, `استخدام ${tag}`);
      const legacyJudge = await createJudge(manager, mine, `قاضي قديم ${tag}`);
      const created = await newCase({ courtId: platformCourt, judgeId: platformJudge }, 201);
      const id = (created.body as Body<{ id: string }>).data.id;
      await raw.legalFile.update({ where: { id }, data: { courtId: mine, judgeId: null } });
      const edit = (body: Record<string, unknown>, status = 200) =>
        http().patch(`/api/v1/cases/${id}`).set(as(manager)).send(body).expect(status);
      expect((await edit({ title: 'Renamed' })).body).toMatchObject({
        data: { court: { id: mine } },
      });
      expect((await edit({ judgeId: legacyJudge })).body).toMatchObject({
        data: { court: { id: mine }, judge: { id: legacyJudge } },
      });
      expect((await edit({ courtId: platformCourt })).body).toMatchObject({
        data: { court: { id: platformCourt }, judge: null },
      });
      expect(JSON.stringify((await edit({ courtId: mine }, 400)).body)).toContain(
        'validation.unknownCourt',
      );
    });

    it('should refuse, in the database, a file naming a court its office cannot see', async () => {
      const theirs = await officeCourt(other, `قاعدة ملف ${tag}`);
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
      ).rejects.toThrow(/cannot see/);
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
      await http()
        .patch(`/api/v1/prosecutors/${id}`)
        .set(as(other))
        .send({ fullName: 'x' })
        .expect(404);
      await http().delete(`/api/v1/prosecutors/${id}`).set(as(other)).expect(404);
      await http()
        .patch(`/api/v1/prosecutors/${id}`)
        .set(as(trainee))
        .send({ fullName: 'x' })
        .expect(403);
      await http().patch(`/api/v1/prosecutors/${id}`).set(as(manager)).send({}).expect(400);
      await http().delete(`/api/v1/prosecutors/${id}`).set(as(manager)).expect(204);
      await http().get(`/api/v1/prosecutors/${id}`).set(as(manager)).expect(404);
    });
  });
});
