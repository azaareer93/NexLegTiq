import { randomUUID } from 'node:crypto';

import { JwtService } from '@nestjs/jwt';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import { FILE_TYPES, JURISDICTIONS } from '@nexlegtiq/shared-types';
import type { Jurisdiction, Role } from '@nexlegtiq/shared-types';
import request from 'supertest';

import { AppModule } from '../../app/app.module';
import { configureApp } from '../../app/configure-app';
import { integrationEnv } from '../../config/env.fixture';
import { PrismaService } from '../../database/prisma.service';
import { TENANT_MODELS } from '../../database/tenant-models';
import type { PrismaClient } from '../../generated/prisma/client';
import { bearerFor } from '../auth/auth.test-helper';
import { PasswordHasher } from '../auth/password-hasher';
import { FILE_TYPE_CODES } from '../legal-files/file-number';
import { totpCode, totpStep } from '../platform-auth/totp';
import { liveSubscription } from '../subscriptions/subscription.test-helper';

type Delegate = { deleteMany(args: unknown): Promise<unknown> };
interface SeededUser {
  readonly userId: string;
  readonly officeId: string;
  readonly role: Role;
}
interface AdminType {
  id: string;
  code: string;
  isActive: boolean;
  subTypes: { id: string; nameEn: string; isActive: boolean }[];
}
type Body<T> = {
  data: T;
  error?: { code: string; details?: { field: string; message: string }[] };
};

const PASSWORD = 'Admin-Correct-Horse-9';
const ORIGIN = 'http://localhost:4201';

/** MVP-175 / D-261 through HTTP on real PostgreSQL: platform file types per country, as offices and files see them. */
describe('legal file types (HTTP + PostgreSQL)', () => {
  let app: NestExpressApplication;
  let raw: PrismaClient;
  let jwt: JwtService;
  const savedEnv = { ...process.env };
  const officeIds: string[] = [];
  const tag = randomUUID()
    .slice(0, 6)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, 'X');
  let email = '';
  let adminId = '';
  let admin = { Authorization: '' };
  let kuwait: SeededUser;
  let palestine: SeededUser;
  let kuwaitClient: string;

  const http = () => request(app.getHttpServer());
  const as = (user: SeededUser) => bearerFor(jwt, user);

  async function seedManager(jurisdiction: Jurisdiction): Promise<SeededUser> {
    const office = await raw.office.create({
      data: {
        name: `Types ${jurisdiction}`,
        jurisdiction,
        settings: { create: {} },
        subscriptions: liveSubscription(),
      },
    });
    officeIds.push(office.id);
    const user = await raw.user.create({
      data: {
        officeId: office.id,
        fullName: 'Manager',
        email: `types-${randomUUID()}@example.test`,
        passwordHash: '!',
        role: 'OFFICE_MANAGER',
      },
    });
    return { userId: user.id, officeId: office.id, role: 'OFFICE_MANAGER' };
  }

  const options = async (user: SeededUser) =>
    (await http().get('/api/v1/file-types').set(as(user)).expect(200)).body as Body<
      { code: string; subTypes: { id: string }[] }[]
    >;

  const openFile = (overrides: Record<string, unknown>) =>
    http()
      .post('/api/v1/cases')
      .set(as(kuwait))
      .send({
        title: 'Types file',
        clientIds: [kuwaitClient],
        primaryClientId: kuwaitClient,
        responsibleLawyerId: kuwait.userId,
        ...overrides,
      });

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
    // unscoped: fixtures across offices and the platform realm.
    raw = app.get(PrismaService).unscoped();
    jwt = app.get(JwtService);

    kuwait = await seedManager('KUWAIT');
    palestine = await seedManager('PALESTINE');
    kuwaitClient = (
      await raw.client.create({
        data: { officeId: kuwait.officeId, clientType: 'INDIVIDUAL', displayName: 'Client' },
      })
    ).id;

    email = `types-admin-${randomUUID()}@example.test`;
    adminId = (
      await raw.platformAdmin.create({
        data: { email, fullName: 'Admin', passwordHash: await new PasswordHasher().hash(PASSWORD) },
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
      const mine = { typeCode: { startsWith: `T${tag}` } };
      await raw.legalFileSubType.deleteMany({ where: mine });
      await raw.legalFileType.deleteMany({ where: { code: { startsWith: `T${tag}` } } });
      await raw.platformAuditLog.deleteMany({ where: { adminId } });
      await raw.platformSession.deleteMany({ where: { adminId } });
      await raw.platformRecoveryCode.deleteMany({ where: { adminId } });
      await raw.platformAdmin.deleteMany({ where: { id: adminId } });
      await raw.loginAttempt.deleteMany({ where: { email } });
    }
    await app?.close();
    process.env = savedEnv;
  });

  it('should have seeded the former FileType values, with their number codes, for every country', async () => {
    for (const jurisdiction of JURISDICTIONS) {
      const seeded = await raw.legalFileType.findMany({
        where: { jurisdiction, code: { in: [...FILE_TYPES] } },
        select: { code: true, numberCode: true },
      });
      expect(Object.fromEntries(seeded.map((t) => [t.code, t.numberCode]))).toEqual(
        FILE_TYPE_CODES,
      );
    }
  });

  it('should keep the platform rows read-only for offices', async () => {
    await expect(app.get(PrismaService).db.legalFileType.deleteMany()).rejects.toThrow(/read-only/);
  });

  it('should let the platform admin manage a country and offices see only its active types', async () => {
    const code = `T${tag}_FAMILY`;
    await http().get('/api/v1/admin/file-types?jurisdiction=KUWAIT').expect(401);
    const created = (
      await http()
        .post('/api/v1/admin/file-types')
        .set(admin)
        .send({
          jurisdiction: 'KUWAIT',
          code,
          numberCode: 'FAM',
          nameAr: 'أحوال شخصية',
          nameEn: 'Family',
        })
        .expect(201)
    ).body as Body<AdminType>;
    const typeId = created.data.id;
    await http()
      .post('/api/v1/admin/file-types')
      .set(admin)
      .send({ jurisdiction: 'KUWAIT', code, numberCode: 'FAM', nameAr: 'أ', nameEn: 'F' })
      .expect(409);
    await http()
      .post('/api/v1/admin/file-types')
      .set(admin)
      .send({ jurisdiction: 'KUWAIT', code: 'lower', numberCode: 'FAM', nameAr: 'أ', nameEn: 'F' })
      .expect(400);
    const withSub = (
      await http()
        .post(`/api/v1/admin/file-types/${typeId}/sub-types`)
        .set(admin)
        .send({ nameAr: 'طلاق', nameEn: 'Divorce' })
        .expect(201)
    ).body as Body<AdminType>;
    const subTypeId = withSub.data.subTypes[0]?.id as string;

    const seen = await options(kuwait);
    expect(seen.data.find((t) => t.code === code)?.subTypes).toEqual([
      { id: subTypeId, nameAr: 'طلاق', nameEn: 'Divorce' },
    ]);
    expect((await options(palestine)).data.map((t) => t.code)).not.toContain(code);

    // A file of the new type gets its number code; another country's type or a foreign sub-type is refused.
    const opened = (await openFile({ fileType: code, subTypeId }).expect(201)).body as Body<
      Record<string, unknown>
    >;
    expect(opened.data).toMatchObject({
      fileType: code,
      fileTypeName: { nameAr: 'أحوال شخصية', nameEn: 'Family' },
      subType: { id: subTypeId, nameEn: 'Divorce' },
      legacySubType: null,
      fileNumber: expect.stringMatching(/-FAM-/),
    });
    const refused = (await openFile({ fileType: 'LITIGATION', subTypeId }).expect(400)).body;
    expect(refused.error?.details).toEqual([
      { field: 'subTypeId', message: 'validation.unknownSubType' },
    ]);

    // Deactivated: gone from new selections, still on the file it classifies; audited.
    await http()
      .patch(`/api/v1/admin/file-sub-types/${subTypeId}`)
      .set(admin)
      .send({ isActive: false })
      .expect(200);
    await http()
      .patch(`/api/v1/admin/file-types/${typeId}`)
      .set(admin)
      .send({ isActive: false, sortOrder: 5 })
      .expect(200);
    expect((await options(kuwait)).data.map((t) => t.code)).not.toContain(code);
    await openFile({ fileType: code }).expect(400);
    const fileId = opened.data['id'] as string;
    const kept = (await http().get(`/api/v1/cases/${fileId}`).set(as(kuwait)).expect(200))
      .body as Body<Record<string, unknown>>;
    expect(kept.data).toMatchObject({ fileType: code, subType: { id: subTypeId } });
    // Keeping a deactivated sub-type is fine; a PATCH that touches something else leaves it.
    await http()
      .patch(`/api/v1/cases/${fileId}`)
      .set(as(kuwait))
      .send({ title: 'Renamed' })
      .expect(200);
    const actions = await raw.platformAuditLog.findMany({
      where: { adminId, entityId: { in: [typeId, subTypeId] } },
      select: { action: true },
    });
    expect(actions.map((a) => a.action).sort()).toEqual([
      'FILE_SUB_TYPE_CREATED',
      'FILE_SUB_TYPE_UPDATED',
      'FILE_TYPE_CREATED',
      'FILE_TYPE_UPDATED',
    ]);
  });

  /** A type of my own in Kuwait (removed with the test's rows), with one sub-type. */
  async function ownType(name: string, numberCode: string) {
    const code = `T${tag}_${name}`;
    const created = (
      await http()
        .post('/api/v1/admin/file-types')
        .set(admin)
        .send({ jurisdiction: 'KUWAIT', code, numberCode, nameAr: `نوع ${name}`, nameEn: name })
        .expect(201)
    ).body as Body<AdminType>;
    const withSub = (
      await http()
        .post(`/api/v1/admin/file-types/${created.data.id}/sub-types`)
        .set(admin)
        .send({ nameAr: 'فرعي', nameEn: 'Sub' })
        .expect(201)
    ).body as Body<AdminType>;
    return { code, typeId: created.data.id, subTypeId: withSub.data.subTypes[0]?.id as string };
  }

  it('should keep legacy sub-type text read-only until a sub-type replaces it, and re-index a renamed one', async () => {
    const { code, subTypeId } = await ownType('LEGACY', 'LGC');
    const opened = (await openFile({ fileType: code }).expect(201)).body as Body<{ id: string }>;
    await raw.legalFile.update({
      where: { id: opened.data.id },
      data: { legacySubType: 'Theft (old text)' },
    });
    const before = (await http().get(`/api/v1/cases/${opened.data.id}`).set(as(kuwait)).expect(200))
      .body as Body<Record<string, unknown>>;
    expect(before.data).toMatchObject({ subType: null, legacySubType: 'Theft (old text)' });
    const after = (
      await http()
        .patch(`/api/v1/cases/${opened.data.id}`)
        .set(as(kuwait))
        .send({ subTypeId })
        .expect(200)
    ).body as Body<Record<string, unknown>>;
    expect(after.data).toMatchObject({ subType: { id: subTypeId }, legacySubType: null });

    // A renamed sub-type is searchable under its new name on the files that have it (D-165).
    const renamed = `Embezzlement${tag}`;
    await http()
      .patch(`/api/v1/admin/file-sub-types/${subTypeId}`)
      .set(admin)
      .send({ nameEn: renamed })
      .expect(200);
    const rows = await raw.$queryRaw<{ text: string }[]>`
      SELECT search_vector_simple::text AS text FROM legal_files WHERE id = ${opened.data.id}::uuid`;
    expect(rows[0]?.text).toContain(renamed.toLowerCase());
  });

  it('should keep offices and anonymous callers out of the platform endpoints', async () => {
    const { typeId, subTypeId } = await ownType('GUARD', 'GRD');
    await http().get('/api/v1/file-types').expect(401);
    const writes = [
      () => http().post('/api/v1/admin/file-types'),
      () => http().patch(`/api/v1/admin/file-types/${typeId}`),
      () => http().post(`/api/v1/admin/file-types/${typeId}/sub-types`),
      () => http().patch(`/api/v1/admin/file-sub-types/${subTypeId}`),
    ];
    for (const write of writes) {
      const res = await write().set(as(kuwait)).send({ nameEn: 'Hijacked' });
      expect([401, 403]).toContain(res.status);
    }
    const type = await raw.legalFileType.findUniqueOrThrow({
      where: { id: typeId },
      include: { subTypes: true },
    });
    expect([type.nameEn, type.subTypes[0]?.nameEn]).toEqual(['GUARD', 'Sub']);
    // A second type may not reuse a number code of its country (the type's part of the file number), nor a sub-type
    // its type's name.
    await http()
      .post('/api/v1/admin/file-types')
      .set(admin)
      .send({
        jurisdiction: 'KUWAIT',
        code: `T${tag}_OTHER`,
        numberCode: 'GRD',
        nameAr: 'أ',
        nameEn: 'B',
      })
      .expect(409);
    await http()
      .post(`/api/v1/admin/file-types/${typeId}/sub-types`)
      .set(admin)
      .send({ nameAr: 'فرعي', nameEn: 'Sub' })
      .expect(409);
  });

  it("should refuse another country's type, in the API and in the database", async () => {
    const { code, typeId } = await ownType('KUWAITONLY', 'KWO');
    const palestineClient = (
      await raw.client.create({
        data: { officeId: palestine.officeId, clientType: 'INDIVIDUAL', displayName: 'Client' },
      })
    ).id;
    const refused = await http()
      .post('/api/v1/cases')
      .set(as(palestine))
      .send({
        title: 'Wrong country',
        fileType: code,
        clientIds: [palestineClient],
        primaryClientId: palestineClient,
        responsibleLawyerId: palestine.userId,
      })
      .expect(400);
    expect((refused.body as Body<unknown>).error?.details).toEqual([
      { field: 'fileType', message: 'validation.unknownFileType' },
    ]);
    const opened = (await openFile({ fileType: code }).expect(201)).body as Body<{ id: string }>;
    // Composite foreign keys: the type must be of the file's country, and a type in use cannot be deleted.
    await expect(
      raw.legalFile.update({ where: { id: opened.data.id }, data: { jurisdiction: 'JORDAN' } }),
    ).rejects.toThrow();
    await expect(raw.legalFileType.delete({ where: { id: typeId } })).rejects.toThrow();
  });
});
