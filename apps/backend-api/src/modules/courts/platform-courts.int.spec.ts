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
import { PasswordHasher } from '../auth/password-hasher';
import { NotificationService } from '../notifications/notification.service';
import { totpCode, totpStep } from '../platform-auth/totp';
import { liveSubscription } from '../subscriptions/subscription.test-helper';

const PASSWORD = 'Admin-Correct-Horse-9';
const ORIGIN = 'http://localhost:4201';

interface SeededUser {
  readonly userId: string;
  readonly officeId: string;
  readonly role: Role;
}
type Body<T = Record<string, unknown>> = { data: T; error?: { code: string } };

/** MVP-167 (D-266) on real PostgreSQL: platform courts in the admin realm, missing-court reports, legacy office courts. */
describe('platform courts (HTTP + PostgreSQL)', () => {
  let app: NestExpressApplication;
  let raw: PrismaClient;
  let jwt: JwtService;
  let notify: jest.SpyInstance;
  const savedEnv = { ...process.env };
  const tag = randomUUID().slice(0, 8);
  const officeIds: string[] = [];
  let email = '';
  let adminId = '';
  let admin = { Authorization: '' };
  let lawyer: SeededUser;
  let trainee: SeededUser;
  let other: SeededUser;

  const http = () => request(app.getHttpServer());
  const as = (user: SeededUser) => bearerFor(jwt, user);
  const dataOf = <T>(res: { body: unknown }) => (res.body as Body<T>).data;
  const codeOf = (res: { body: unknown }) => (res.body as Body).error?.code;

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
        fullName: `${role} ${tag}`,
        email: `pcourts-${randomUUID()}@example.test`,
        passwordHash: '!',
        role,
      },
    });
    return { userId: user.id, officeId, role };
  }

  const addCourt = async (body: Record<string, unknown> = {}) =>
    dataOf<{ id: string }>(
      await http()
        .post('/api/v1/admin/courts')
        .set(admin)
        .send({
          jurisdiction: 'PALESTINE',
          courtType: 'MAGISTRATE',
          nameAr: `محكمة ${randomUUID().slice(0, 6)} ${tag}`,
          nameEn: `Court ${randomUUID()}`,
          ...body,
        })
        .expect(201),
    ).id;

  const pickerIds = async (user: SeededUser) =>
    dataOf<{ id: string }[]>(
      await http().get(`/api/v1/courts?limit=100&search=${tag}`).set(as(user)).expect(200),
    ).map((row) => row.id);

  async function fileAt(user: SeededUser, courtId: string | null, judgeId: string | null = null) {
    return raw.legalFile.create({
      data: {
        officeId: user.officeId,
        fileNumber: `PC-${randomUUID()}`,
        title: 'Court file',
        fileType: 'LITIGATION',
        responsibleLawyerId: user.userId,
        jurisdiction: 'PALESTINE',
        currency: 'ILS',
        courtId,
        judgeId,
      },
    });
  }

  beforeAll(async () => {
    Object.assign(process.env, integrationEnv(), {
      EMAIL_VERIFICATION_ENFORCED: 'false',
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
    // unscoped: fixtures across offices, platform rows and the platform admin.
    raw = app.get(PrismaService).unscoped();
    jwt = app.get(JwtService);
    notify = jest.spyOn(app.get(NotificationService), 'notify').mockResolvedValue(undefined);

    email = `admin-${randomUUID()}@example.test`;
    adminId = (
      await raw.platformAdmin.create({
        data: {
          email,
          fullName: 'Platform Admin',
          passwordHash: await new PasswordHasher().hash(PASSWORD),
        },
      })
    ).id;
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
    admin = { Authorization: `Bearer ${confirmed.body.data.accessToken as string}` };

    const officeId = await seedOffice(`Courts office ${tag}`);
    lawyer = await seedUser(officeId, 'LAWYER');
    trainee = await seedUser(officeId, 'TRAINEE');
    other = await seedUser(await seedOffice(`Other courts office ${tag}`), 'OFFICE_MANAGER');
  }, 60_000);

  afterAll(async () => {
    if (raw) {
      const where = { officeId: { in: officeIds } };
      await raw.courtReport.deleteMany({ where });
      await raw.session.deleteMany({ where });
      await raw.legalFile.deleteMany({ where });
      await raw.auditLog.deleteMany({ where });
      await raw.judge.deleteMany({ where });
      const platform = { officeId: null, nameAr: { contains: tag } };
      await raw.judge.deleteMany({ where: { court: platform } });
      await raw.court.deleteMany({ where });
      await raw.court.deleteMany({ where: platform });
      await raw.subscription.deleteMany({ where });
      await raw.officeSettings.deleteMany({ where });
      await raw.user.deleteMany({ where });
      await raw.office.deleteMany({ where: { id: { in: officeIds } } });
      await raw.platformAuditLog.deleteMany({ where: { adminId } });
      await raw.platformSession.deleteMany({ where: { adminId } });
      await raw.platformRecoveryCode.deleteMany({ where: { adminId } });
      await raw.platformAdmin.deleteMany({ where: { id: adminId } });
      await raw.loginAttempt.deleteMany({ where: { email } });
    }
    await app?.close();
    process.env = savedEnv;
  });

  describe('admin courts', () => {
    it('should create, list, edit and deactivate platform courts per country, audited', async () => {
      const id = await addCourt({ city: 'الخليل' });
      const jordan = await addCourt({ jurisdiction: 'JORDAN' });
      const list = dataOf<{ id: string }[]>(
        await http()
          .get(`/api/v1/admin/courts?jurisdiction=PALESTINE&search=${tag}&limit=100`)
          .set(admin)
          .expect(200),
      ).map((row) => row.id);
      expect(list).toContain(id);
      expect(list).not.toContain(jordan);
      expect(await pickerIds(lawyer)).toContain(id);
      const edited = await http()
        .patch(`/api/v1/admin/courts/${id}`)
        .set(admin)
        .send({ isActive: false, city: null })
        .expect(200);
      expect(dataOf(edited)).toMatchObject({ isActive: false, city: null });
      expect(await pickerIds(lawyer)).not.toContain(id);
      const audit = await raw.platformAuditLog.findFirstOrThrow({
        where: { adminId, action: 'COURT_UPDATED', entityId: id },
      });
      expect(audit.newValues).toEqual({ isActive: false, city: null });
      // Still listed for the admin, who can reactivate it.
      await http()
        .get(`/api/v1/admin/courts?jurisdiction=PALESTINE&search=${tag}&limit=100`)
        .set(admin)
        .expect(200)
        .expect(({ body }) => expect(JSON.stringify(body)).toContain(id));
    });

    it('should refuse a taken English name (409), a bad body (400) and an office court (404)', async () => {
      const nameEn = `Unique ${tag}`;
      await addCourt({ nameEn });
      const taken = await http()
        .post('/api/v1/admin/courts')
        .set(admin)
        .send({ jurisdiction: 'PALESTINE', courtType: 'MAGISTRATE', nameAr: `ب ${tag}`, nameEn })
        .expect(409);
      expect(codeOf(taken)).toBe('RES-002');
      await http()
        .post('/api/v1/admin/courts')
        .set(admin)
        .send({ jurisdiction: 'PALESTINE', courtType: 'MAGISTRATE', nameAr: 'x' })
        .expect(400);
      const legacy = await raw.court.create({
        data: {
          officeId: lawyer.officeId,
          jurisdiction: 'PALESTINE',
          courtType: 'MAGISTRATE',
          nameAr: `مكتبية ${tag}`,
        },
      });
      await http()
        .patch(`/api/v1/admin/courts/${legacy.id}`)
        .set(admin)
        .send({ city: 'x' })
        .expect(404);
    });

    it('should keep office tokens out of the admin realm', async () => {
      const res = await http().get('/api/v1/admin/courts?jurisdiction=PALESTINE').set(as(other));
      expect([401, 403]).toContain(res.status);
      const anonymous = await http().post('/api/v1/admin/court-reports/x/dismiss').send({});
      expect([401, 403]).toContain(anonymous.status);
    });
  });

  describe('missing-court reports', () => {
    it('should let a lawyer report, the admin add it, and notify the reporter', async () => {
      const created = await http()
        .post('/api/v1/court-reports')
        .set(as(lawyer))
        .send({ name: `صلح يطا ${tag}`, city: 'يطا', note: 'لم نجدها' })
        .expect(201);
      const reportId = dataOf<{ id: string; status: string }>(created).id;
      expect(dataOf(created)).toMatchObject({ status: 'PENDING' });
      await raw.auditLog.findFirstOrThrow({
        where: { entityType: 'CourtReport', entityId: reportId, action: 'CREATE' },
      });
      const queue = dataOf<{ id: string; officeName: string; reportedByName: string }[]>(
        await http()
          .get('/api/v1/admin/court-reports?status=PENDING&limit=100')
          .set(admin)
          .expect(200),
      );
      expect(queue.find((row) => row.id === reportId)).toMatchObject({
        officeName: `Courts office ${tag}`,
        reportedByName: `LAWYER ${tag}`,
      });
      const added = await http()
        .post(`/api/v1/admin/court-reports/${reportId}/add`)
        .set(admin)
        .send({ courtType: 'MAGISTRATE', nameAr: `محكمة صلح يطا ${tag}`, nameEn: `Yatta ${tag}` })
        .expect(200);
      const courtId = dataOf<{ courtId: string }>(added).courtId;
      expect(dataOf(added)).toMatchObject({ status: 'ADDED' });
      expect(await pickerIds(lawyer)).toContain(courtId);
      expect(notify).toHaveBeenCalledWith(
        [lawyer.userId],
        expect.objectContaining({
          type: 'COURT_REPORT_RESOLVED',
          titleKey: 'common.notifications.courtReportAdded',
        }),
        { jobId: `court-report-${reportId}` },
      );
      const again = await http()
        .post(`/api/v1/admin/court-reports/${reportId}/dismiss`)
        .set(admin)
        .send({})
        .expect(422);
      expect(codeOf(again)).toBe('BIZ-029');
    });

    it('should dismiss with a reason, and refuse a trainee (403) or an empty name (400)', async () => {
      const id = dataOf<{ id: string }>(
        await http()
          .post('/api/v1/court-reports')
          .set(as(lawyer))
          .send({ name: `مكررة ${tag}` })
          .expect(201),
      ).id;
      const dismissed = await http()
        .post(`/api/v1/admin/court-reports/${id}/dismiss`)
        .set(admin)
        .send({ reason: 'موجودة' })
        .expect(200);
      expect(dataOf(dismissed)).toMatchObject({ status: 'DISMISSED', dismissReason: 'موجودة' });
      await http().post('/api/v1/court-reports').set(as(trainee)).send({ name: 'x' }).expect(403);
      await http().post('/api/v1/court-reports').set(as(lawyer)).send({ name: '' }).expect(400);
      await http()
        .post(`/api/v1/admin/court-reports/${randomUUID()}/dismiss`)
        .set(admin)
        .send({})
        .expect(404);
    });
  });

  describe('legacy office courts', () => {
    it('should replace an office court: files, hearings and judges re-pointed, no other office touched', async () => {
      const legacy = await raw.court.create({
        data: {
          officeId: lawyer.officeId,
          jurisdiction: 'PALESTINE',
          courtType: 'MAGISTRATE',
          nameAr: `قديمة ${tag}`,
        },
      });
      const judge = await raw.judge.create({
        data: { officeId: lawyer.officeId, courtId: legacy.id, fullName: `قاض ${tag}` },
      });
      const file = await fileAt(lawyer, legacy.id, judge.id);
      await raw.session.create({
        data: {
          officeId: lawyer.officeId,
          fileId: file.id,
          startsAt: new Date(Date.now() + 86_400_000),
          attendingLawyerId: lawyer.userId,
          createdById: lawyer.userId,
          reminderDays: [],
          courtId: legacy.id,
          judgeId: judge.id,
        },
      });
      const target = await addCourt();
      const otherCourt = await addCourt();
      const otherFile = await fileAt(other, otherCourt);
      const listed = dataOf<{ id: string; fileCount: number; sessionCount: number }[]>(
        await http()
          .get(`/api/v1/admin/office-courts?search=${tag}&limit=100`)
          .set(admin)
          .expect(200),
      ).find((row) => row.id === legacy.id);
      expect(listed).toMatchObject({ fileCount: 1, sessionCount: 1, judgeCount: 1 });
      const jordan = await addCourt({ jurisdiction: 'JORDAN' });
      await http()
        .post(`/api/v1/admin/office-courts/${legacy.id}/replace`)
        .set(admin)
        .send({ courtId: jordan })
        .expect(400);
      const res = await http()
        .post(`/api/v1/admin/office-courts/${legacy.id}/replace`)
        .set(admin)
        .send({ courtId: target })
        .expect(200);
      expect(dataOf(res)).toEqual({ courtId: target, files: 1, sessions: 1, judges: 1 });
      expect(await raw.court.count({ where: { id: legacy.id } })).toBe(0);
      expect(await raw.legalFile.findUniqueOrThrow({ where: { id: file.id } })).toMatchObject({
        courtId: target,
        judgeId: judge.id,
        updatedAt: file.updatedAt,
      });
      expect(await raw.session.count({ where: { courtId: target, judgeId: judge.id } })).toBe(1);
      expect(await raw.judge.findUniqueOrThrow({ where: { id: judge.id } })).toMatchObject({
        courtId: target,
        officeId: lawyer.officeId,
      });
      expect((await raw.legalFile.findUniqueOrThrow({ where: { id: otherFile.id } })).courtId).toBe(
        otherCourt,
      );
      await raw.platformAuditLog.findFirstOrThrow({
        where: { adminId, action: 'OFFICE_COURT_REPLACED', targetOfficeId: lawyer.officeId },
      });
      // The office-owned and platform guards still hold outside the admin's transaction.
      await expect(
        raw.judge.update({ where: { id: judge.id }, data: { courtId: otherCourt } }),
      ).rejects.toThrow(/cannot move/);
    });

    it('should promote an office court into a platform court of its country', async () => {
      const legacy = await raw.court.create({
        data: {
          officeId: lawyer.officeId,
          jurisdiction: 'PALESTINE',
          courtType: 'SHARIA',
          nameAr: `شرعية ${tag}`,
        },
      });
      await fileAt(lawyer, legacy.id);
      await http()
        .post(`/api/v1/admin/office-courts/${legacy.id}/promote`)
        .set(admin)
        .send({})
        .expect(400);
      const res = await http()
        .post(`/api/v1/admin/office-courts/${legacy.id}/promote`)
        .set(admin)
        .send({ nameEn: `Sharia ${tag}` })
        .expect(200);
      expect(dataOf(res)).toMatchObject({ id: legacy.id, isPlatform: true });
      expect(await pickerIds(other)).toContain(legacy.id);
      await http()
        .post(`/api/v1/admin/office-courts/${legacy.id}/promote`)
        .set(admin)
        .send({})
        .expect(404);
    });

    it("should carry a legacy court over to an outcome's next hearing, but not to a new one", async () => {
      const legacy = await raw.court.create({
        data: {
          officeId: lawyer.officeId,
          jurisdiction: 'PALESTINE',
          courtType: 'MAGISTRATE',
          nameAr: `جلسات قديمة ${tag}`,
        },
      });
      const file = await fileAt(lawyer, legacy.id);
      const fresh = await http()
        .post('/api/v1/sessions')
        .set(as(lawyer))
        .send({
          fileId: file.id,
          sessionType: 'HEARING',
          startsAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
          attendingLawyerId: lawyer.userId,
          courtId: legacy.id,
        })
        .expect(400);
      expect(JSON.stringify(fresh.body)).toContain('validation.unknownCourt');
      const held = await raw.session.create({
        data: {
          officeId: lawyer.officeId,
          fileId: file.id,
          startsAt: new Date(Date.now() - 86_400_000),
          attendingLawyerId: lawyer.userId,
          createdById: lawyer.userId,
          reminderDays: [],
          courtId: legacy.id,
        },
      });
      await http()
        .post(`/api/v1/sessions/${held.id}/outcome`)
        .set(as(lawyer))
        .send({
          outcome: 'ADJOURNED',
          nextSession: { startsAt: new Date(Date.now() + 3 * 86_400_000).toISOString() },
        })
        .expect(200);
      expect(await raw.session.count({ where: { fileId: file.id, courtId: legacy.id } })).toBe(2);
    });
  });
});
