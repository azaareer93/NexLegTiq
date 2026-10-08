import { randomUUID } from 'node:crypto';

import { JwtService } from '@nestjs/jwt';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Role } from '@nexlegtiq/shared-types';
import request from 'supertest';

import { AppModule } from '../../app/app.module';
import { configureApp } from '../../app/configure-app';
import { AppConfig } from '../../config/app-config';
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

/** MVP-57 through HTTP on real PostgreSQL: create, list, get, update and soft delete of legal files (D-051, D-096). */
describe('cases API (HTTP + PostgreSQL)', () => {
  let app: NestExpressApplication;
  let raw: PrismaClient;
  let jwt: JwtService;
  const officeIds: string[] = [];
  const savedEnv = { ...process.env };

  const users: Record<string, SeededUser> = {};
  let officeId: string;
  let otherOffice: SeededUser;
  let clientA: string;
  let clientB: string;
  let inactiveClient: string;
  let otherOfficeClient: string;

  const http = () => request(app.getHttpServer());
  const as = (user: SeededUser) => bearerFor(jwt, user);

  async function seedUser(office: string, role: Role): Promise<SeededUser> {
    const user = await raw.user.create({
      data: {
        officeId: office,
        fullName: `${role} ${randomUUID().slice(0, 4)}`,
        email: `cases-${randomUUID()}@example.test`,
        passwordHash: '!',
        role,
      },
    });
    return { userId: user.id, officeId: office, role };
  }

  async function seedOffice(name: string): Promise<string> {
    const office = await raw.office.create({
      data: { name, currency: 'JOD', settings: { create: { defaultBillingRate: '150' } } },
    });
    officeIds.push(office.id);
    return office.id;
  }

  const seedClient = (office: string, displayName: string, isActive = true) =>
    raw.client
      .create({ data: { officeId: office, clientType: 'INDIVIDUAL', displayName, isActive } })
      .then((client) => client.id);

  const body = (overrides: Record<string, unknown> = {}) => ({
    title: 'Land dispute — Ramallah',
    fileType: 'LITIGATION',
    clientIds: [clientA],
    primaryClientId: clientA,
    responsibleLawyerId: users['lawyer']?.userId,
    ...overrides,
  });

  const create = (user: SeededUser, overrides: Record<string, unknown> = {}) =>
    http().post('/api/v1/cases').set(as(user)).send(body(overrides));

  /** Creates a file through the API as the office manager and returns its id. */
  async function file(overrides: Record<string, unknown> = {}): Promise<string> {
    const res = await create(users['manager'] as SeededUser, overrides).expect(201);
    return (res.body as { data: { id: string } }).data.id;
  }

  const listIds = async (user: SeededUser, query = '') =>
    (
      (await http().get(`/api/v1/cases${query}`).set(as(user)).expect(200)).body as {
        data: { id: string }[];
      }
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
    // unscoped: test fixtures create offices, users and clients across offices.
    raw = app.get(PrismaService).unscoped();
    jwt = app.get(JwtService);
    expect(app.get(AppConfig)).toBeDefined();

    officeId = await seedOffice('Cases office');
    for (const [key, role] of [
      ['manager', 'OFFICE_MANAGER'],
      ['senior', 'SENIOR_LAWYER'],
      ['lawyer', 'LAWYER'],
      ['otherLawyer', 'LAWYER'],
      ['paralegal', 'PARALEGAL'],
      ['admin', 'ADMIN'],
      ['trainee', 'TRAINEE'],
      ['collaborator', 'EXTERNAL_COLLABORATOR'],
    ] as const) {
      users[key] = await seedUser(officeId, role);
    }
    clientA = await seedClient(officeId, 'Ahmad Haddad');
    clientB = await seedClient(officeId, 'شركة القدس للتجارة');
    inactiveClient = await seedClient(officeId, 'Former client', false);
    const other = await seedOffice('Other office');
    otherOffice = await seedUser(other, 'OFFICE_MANAGER');
    otherOfficeClient = await seedClient(other, 'Other client');
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

  describe('POST /cases', () => {
    it('should open a file with its number, clients, team, timeline event and audit row', async () => {
      const lawyer = users['lawyer'] as SeededUser;
      const res = await create(lawyer, {
        clientIds: [clientA, clientB],
        primaryClientId: clientB,
        responsibleParalegalId: users['paralegal']?.userId,
      }).expect(201);
      const data = (res.body as { data: Record<string, unknown> }).data;
      const year = new Date().getUTCFullYear();
      expect(data).toMatchObject({
        fileNumber: expect.stringMatching(
          new RegExp(`^(${year - 1}|${year}|${year + 1})-LIT-\\d{5}$`),
        ),
        title: 'Land dispute — Ramallah',
        status: 'OPEN',
        priority: 'MEDIUM',
        currency: 'JOD',
        jurisdiction: 'PALESTINE',
        billingMethod: 'HOURLY',
        hourlyRate: '150.00',
        retainerBalance: '0.00',
        primaryClient: { id: clientB, displayName: 'شركة القدس للتجارة' },
        responsibleLawyer: { id: lawyer.userId },
        responsibleParalegal: { id: users['paralegal']?.userId },
        counts: { parties: 0, notes: 0 },
      });
      expect(data['clients']).toEqual([
        expect.objectContaining({ id: clientB, isPrimary: true }),
        expect.objectContaining({ id: clientA, isPrimary: false }),
      ]);
      expect((data['team'] as { role: string }[]).map((member) => member.role).sort()).toEqual([
        'PARALEGAL',
        'RESPONSIBLE_LAWYER',
      ]);
      const id = data['id'] as string;
      await expect(
        raw.caseTimelineEvent.findMany({
          where: { fileId: id },
          select: { eventType: true, actorId: true },
        }),
      ).resolves.toEqual([{ eventType: 'FILE_OPENED', actorId: lawyer.userId }]);
      await expect(
        raw.auditLog.count({ where: { entityId: id, action: 'CREATE', userId: lawyer.userId } }),
      ).resolves.toBe(1);
    });

    it.each([
      ['a missing title', { title: '' }, 'title'],
      ['a primary client outside the list', { primaryClientId: randomUUID() }, 'primaryClientId'],
      ['the same client twice', () => ({ clientIds: [clientA, clientA] }), 'clientIds'],
      [
        'an inactive client',
        () => ({ clientIds: [inactiveClient], primaryClientId: inactiveClient }),
        'clientIds',
      ],
      [
        "another office's client",
        () => ({ clientIds: [otherOfficeClient], primaryClientId: otherOfficeClient }),
        'clientIds',
      ],
      [
        'a paralegal as responsible lawyer',
        () => ({ responsibleLawyerId: users['paralegal']?.userId }),
        'responsibleLawyerId',
      ],
      [
        "another office's lawyer",
        () => ({ responsibleLawyerId: otherOffice.userId }),
        'responsibleLawyerId',
      ],
      [
        'a lawyer as paralegal',
        () => ({ responsibleParalegalId: users['otherLawyer']?.userId }),
        'responsibleParalegalId',
      ],
      ['a negative or over-precise fee', { fixedFee: '12.345' }, 'fixedFee'],
      ['bidi controls in the title', { title: 'abc‮def' }, 'title'],
    ])('should refuse %s (400 VAL-001 on the field)', async (_case, overrides, field) => {
      const values = typeof overrides === 'function' ? overrides() : overrides;
      const res = await create(users['manager'] as SeededUser, values).expect(400);
      expect(res.body).toMatchObject({ error: { code: 'VAL-001' } });
      expect(
        (res.body as { error: { details: { field: string }[] } }).error.details.map((d) => d.field),
      ).toContain(field);
    });

    it.each(['admin', 'trainee', 'collaborator'])(
      'should refuse %s (403 AUTH-100)',
      async (key) => {
        const res = await create(users[key] as SeededUser).expect(403);
        expect(res.body).toMatchObject({ error: { code: 'AUTH-100' } });
      },
    );
  });

  describe('visibility (D-051, D-096)', () => {
    let lawyersFile: string;
    let othersFile: string;
    let confidentialFile: string;
    let teamFile: string;

    beforeAll(async () => {
      lawyersFile = await file();
      othersFile = await file({ responsibleLawyerId: users['otherLawyer']?.userId });
      confidentialFile = await file({
        responsibleLawyerId: users['otherLawyer']?.userId,
        isConfidential: true,
      });
      teamFile = await file({ responsibleLawyerId: users['otherLawyer']?.userId });
      await raw.fileTeamMember.create({
        data: { officeId, fileId: teamFile, userId: (users['collaborator'] as SeededUser).userId },
      });
    });

    it.each([
      ['manager', () => [lawyersFile, othersFile, confidentialFile, teamFile], () => []],
      ['senior', () => [lawyersFile, othersFile, teamFile], () => [confidentialFile]],
      ['admin', () => [lawyersFile, othersFile, teamFile], () => [confidentialFile]],
      ['lawyer', () => [lawyersFile], () => [othersFile, confidentialFile, teamFile]],
      ['otherLawyer', () => [othersFile, confidentialFile, teamFile], () => [lawyersFile]],
      ['collaborator', () => [teamFile], () => [lawyersFile, othersFile, confidentialFile]],
      ['trainee', () => [], () => [lawyersFile, othersFile, confidentialFile, teamFile]],
    ] as [string, () => string[], () => string[]][])(
      'should show %s exactly the files it may see',
      async (key, seen, hidden) => {
        const user = users[key] as SeededUser;
        const ids = await listIds(user, '?limit=100');
        const hiddenIds = hidden();
        expect(ids).toEqual(expect.arrayContaining(seen()));
        expect(ids.filter((id) => hiddenIds.includes(id))).toEqual([]);
        for (const id of seen()) {
          await http().get(`/api/v1/cases/${id}`).set(as(user)).expect(200);
        }
        for (const id of hiddenIds) {
          const res = await http().get(`/api/v1/cases/${id}`).set(as(user)).expect(404);
          expect(res.body).toMatchObject({ error: { code: 'RES-001' } });
        }
      },
    );

    it('should hide every file from another office (404 RES-001), and a malformed id the same way', async () => {
      expect(await listIds(otherOffice, '?limit=100')).toEqual([]);
      for (const path of [`/api/v1/cases/${lawyersFile}`, '/api/v1/cases/not-a-uuid']) {
        const res = await http().get(path).set(as(otherOffice)).expect(404);
        expect(res.body).toMatchObject({ error: { code: 'RES-001' } });
      }
      await http()
        .patch(`/api/v1/cases/${lawyersFile}`)
        .set(as(otherOffice))
        .send({ title: 'x' })
        .expect(404);
      await http().delete(`/api/v1/cases/${lawyersFile}`).set(as(otherOffice)).expect(404);
    });

    it('should narrow to assigned files with scope=mine, also with view:all:cases', async () => {
      const ids = await listIds(users['otherLawyer'] as SeededUser, '?scope=mine&limit=100');
      expect(ids).toEqual(expect.arrayContaining([othersFile, confidentialFile, teamFile]));
      expect(await listIds(users['manager'] as SeededUser, '?scope=mine&limit=100')).not.toContain(
        lawyersFile,
      );
    });
  });

  describe('GET /cases filters, search, sort and pagination', () => {
    let filtered: string[];

    beforeAll(async () => {
      filtered = [
        await file({
          title: 'Alpha employment claim',
          fileType: 'EMPLOYMENT_CONTRACT',
          priority: 'URGENT',
        }),
        await file({
          title: 'Beta rental',
          fileType: 'RENTAL_AGREEMENT',
          clientIds: [clientB],
          primaryClientId: clientB,
        }),
        await file({ title: 'Gamma rental', fileType: 'RENTAL_AGREEMENT', priority: 'LOW' }),
      ];
    });

    const manager = () => users['manager'] as SeededUser;

    it('should filter by type, priority, client and responsible lawyer', async () => {
      const rentals = await listIds(manager(), '?fileType=RENTAL_AGREEMENT&limit=100');
      expect(rentals).toEqual(expect.arrayContaining([filtered[1], filtered[2]]));
      expect(rentals).not.toContain(filtered[0]);
      expect(await listIds(manager(), '?priority=URGENT&fileType=EMPLOYMENT_CONTRACT')).toEqual([
        filtered[0],
      ]);
      expect(await listIds(manager(), `?clientId=${clientB}&fileType=RENTAL_AGREEMENT`)).toEqual([
        filtered[1],
      ]);
      const byLawyer = await listIds(
        manager(),
        `?responsibleLawyerId=${users['lawyer']?.userId}&limit=100`,
      );
      expect(byLawyer).toEqual(expect.arrayContaining(filtered));
    });

    it('should search title, number and client name, ignoring case', async () => {
      expect(await listIds(manager(), '?search=gamma')).toEqual([filtered[2]]);
      expect(
        await listIds(
          manager(),
          `?search=${encodeURIComponent('القدس')}&fileType=RENTAL_AGREEMENT`,
        ),
      ).toEqual([filtered[1]]);
      const { body: one } = await http()
        .get(`/api/v1/cases/${filtered[0]}`)
        .set(as(manager()))
        .expect(200);
      const number = (one as { data: { fileNumber: string } }).data.fileNumber;
      expect(await listIds(manager(), `?search=${number}`)).toEqual([filtered[0]]);
    });

    it('should sort by allowed fields and paginate with meta', async () => {
      const res = await http()
        .get('/api/v1/cases?fileType=RENTAL_AGREEMENT&sort=title:desc&limit=1&page=2')
        .set(as(manager()))
        .expect(200);
      const page = res.body as { data: { title: string }[]; meta: { pagination: object } };
      expect(page.data.map((row) => row.title)).toEqual(['Beta rental']);
      expect(page.meta.pagination).toEqual({
        page: 2,
        limit: 1,
        total: 2,
        totalPages: 2,
        hasMore: false,
      });
    });

    it.each([
      '?sort=passwordHash:asc',
      '?sort=title:sideways',
      '?limit=101',
      '?status=DELETED',
      '?clientId=x',
    ])('should refuse %s (400 VAL-001)', async (query) => {
      const res = await http().get(`/api/v1/cases${query}`).set(as(manager())).expect(400);
      expect(res.body).toMatchObject({ error: { code: 'VAL-001' } });
    });
  });

  describe('PATCH and DELETE', () => {
    it('should let an assigned lawyer edit, audit the change, and clear optional fields with null', async () => {
      const id = await file({ description: 'First draft', courtCaseNumber: '123/2026' });
      const lawyer = users['lawyer'] as SeededUser;
      const res = await http()
        .patch(`/api/v1/cases/${id}`)
        .set(as(lawyer))
        .send({ title: 'Renamed', priority: 'HIGH', courtCaseNumber: null, fixedFee: '2500' })
        .expect(200);
      expect((res.body as { data: object }).data).toMatchObject({
        title: 'Renamed',
        priority: 'HIGH',
        courtCaseNumber: null,
        fixedFee: '2500.00',
        description: 'First draft',
      });
      const audit = await raw.auditLog.findFirstOrThrow({
        where: { entityId: id, action: 'UPDATE' },
      });
      expect(audit).toMatchObject({
        userId: lawyer.userId,
        oldValues: { title: 'Land dispute — Ramallah', courtCaseNumber: '123/2026' },
        newValues: { title: 'Renamed', courtCaseNumber: null },
      });
    });

    it('should let a senior lawyer edit any visible file, and refuse an unassigned lawyer (404) and admin staff (403)', async () => {
      const id = await file({ responsibleLawyerId: users['otherLawyer']?.userId });
      await http()
        .patch(`/api/v1/cases/${id}`)
        .set(as(users['senior'] as SeededUser))
        .send({ priority: 'LOW' })
        .expect(200);
      await http()
        .patch(`/api/v1/cases/${id}`)
        .set(as(users['lawyer'] as SeededUser))
        .send({ priority: 'LOW' })
        .expect(404);
      await http()
        .patch(`/api/v1/cases/${id}`)
        .set(as(users['admin'] as SeededUser))
        .send({ priority: 'LOW' })
        .expect(403);
    });

    it.each([
      ['an empty body', {}],
      ['a number change (not editable)', { fileNumber: 'X-1' }],
      ['a bad amount', { hourlyRate: '-5' }],
    ])('should refuse %s (400 VAL-001)', async (_case, payload) => {
      const id = await file();
      const res = await http()
        .patch(`/api/v1/cases/${id}`)
        .set(as(users['manager'] as SeededUser))
        .send(payload)
        .expect(400);
      expect(res.body).toMatchObject({ error: { code: 'VAL-001' } });
    });

    it('should soft-delete for delete:case only: gone from lists and 404 afterwards, number kept', async () => {
      const id = await file();
      await http()
        .delete(`/api/v1/cases/${id}`)
        .set(as(users['lawyer'] as SeededUser))
        .expect(403);
      await http()
        .delete(`/api/v1/cases/${id}`)
        .set(as(users['senior'] as SeededUser))
        .expect(204);
      await http()
        .get(`/api/v1/cases/${id}`)
        .set(as(users['manager'] as SeededUser))
        .expect(404);
      expect(await listIds(users['manager'] as SeededUser, '?limit=100')).not.toContain(id);
      await expect(raw.legalFile.findUniqueOrThrow({ where: { id } })).resolves.toMatchObject({
        deletedAt: expect.any(Date),
      });
      await expect(raw.auditLog.count({ where: { entityId: id, action: 'DELETE' } })).resolves.toBe(
        1,
      );
    });

    it('should keep an archived file read-only (422 BIZ-007) but readable', async () => {
      const id = await file();
      await raw.legalFile.update({ where: { id }, data: { status: 'ARCHIVED' } });
      const manager = users['manager'] as SeededUser;
      await http().get(`/api/v1/cases/${id}`).set(as(manager)).expect(200);
      const patched = await http()
        .patch(`/api/v1/cases/${id}`)
        .set(as(manager))
        .send({ title: 'x' });
      const deleted = await http().delete(`/api/v1/cases/${id}`).set(as(manager));
      for (const res of [patched, deleted]) {
        expect(res.status).toBe(422);
        expect(res.body).toMatchObject({ error: { code: 'BIZ-007' } });
      }
    });
  });
});
