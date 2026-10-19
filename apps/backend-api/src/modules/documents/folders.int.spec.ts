import { randomUUID } from 'node:crypto';

import { JwtService } from '@nestjs/jwt';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import { FOLDER_SYSTEM_KEYS } from '@nexlegtiq/shared-types';
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

interface FolderBody {
  id: string;
  parentId: string | null;
  name: string | null;
  systemKey: string | null;
  documentCount: number;
}

/** MVP-71 through HTTP on real PostgreSQL: default folders, folder CRUD, rules and access (D-119). */
describe('folders API (HTTP + PostgreSQL)', () => {
  // Each test opens a file through the API and makes several calls; the default 5 s is too tight in the full run.
  jest.setTimeout(30_000);
  let app: NestExpressApplication;
  let raw: PrismaClient;
  let jwt: JwtService;
  const officeIds: string[] = [];
  const savedEnv = { ...process.env };
  const users: Record<string, SeededUser> = {};
  let officeId: string;
  let clientId: string;
  let other: SeededUser;

  const http = () => request(app.getHttpServer());
  const user = (key: string) => users[key] as SeededUser;
  const as = (key: string) => bearerFor(jwt, user(key));
  const path = (fileId: string, folderId = '') =>
    `/api/v1/cases/${fileId}/folders${folderId && `/${folderId}`}`;

  async function seedOffice(name: string): Promise<string> {
    const office = await raw.office.create({ data: { name, settings: { create: {} } } });
    officeIds.push(office.id);
    return office.id;
  }

  async function seedUser(office: string, role: Role): Promise<SeededUser> {
    const created = await raw.user.create({
      data: {
        officeId: office,
        fullName: role,
        email: `folders-${randomUUID()}@example.test`,
        passwordHash: '!',
        role,
      },
    });
    return { userId: created.id, officeId: office, role };
  }

  /** A file opened through the API (so it gets its default folders), with the trainee on its team. */
  async function openFile(): Promise<string> {
    const res = await http()
      .post('/api/v1/cases')
      .set(as('manager'))
      .send({
        title: 'Folders test file',
        fileType: 'LITIGATION',
        clientIds: [clientId],
        primaryClientId: clientId,
        responsibleLawyerId: user('lawyer').userId,
      })
      .expect(201);
    const fileId = (res.body as { data: { id: string } }).data.id;
    await raw.fileTeamMember.create({
      data: { officeId, fileId, userId: user('trainee').userId },
    });
    return fileId;
  }

  const list = async (fileId: string, key = 'lawyer') =>
    ((await http().get(path(fileId)).set(as(key)).expect(200)).body as { data: FolderBody[] }).data;

  async function folder(fileId: string, body: object, key = 'lawyer'): Promise<FolderBody> {
    const res = await http().post(path(fileId)).set(as(key)).send(body);
    expect(res.status).toBe(201);
    return (res.body as { data: FolderBody }).data;
  }

  const expectError = (res: request.Response, status: number, code: string, field?: string) =>
    expect({ status: res.status, body: res.body as unknown }).toMatchObject({
      status,
      body: { error: { code, ...(field && { details: [{ field }] }) } },
    });

  async function seedDocument(fileId: string, folderId: string, deleted = false) {
    const stored = {
      originalFilename: 'عقد.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 10n,
      checksumSha256: 'b'.repeat(64),
      storageKey: `${officeId}/${fileId}/${randomUUID()}.pdf`,
    };
    return raw.document.create({
      data: {
        officeId,
        fileId,
        folderId,
        name: 'Contract',
        ...stored,
        uploadedById: user('lawyer').userId,
        deletedAt: deleted ? new Date() : null,
      },
    });
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
    // unscoped: test fixtures create offices, users, clients and documents across offices.
    raw = app.get(PrismaService).unscoped();
    jwt = app.get(JwtService);
    officeId = await seedOffice('Folders office');
    for (const [key, role] of [
      ['manager', 'OFFICE_MANAGER'],
      ['lawyer', 'LAWYER'],
      ['trainee', 'TRAINEE'],
      ['outsider', 'EXTERNAL_COLLABORATOR'],
      ['admin', 'ADMIN'],
      ['senior', 'SENIOR_LAWYER'],
    ] as const) {
      users[key] = await seedUser(officeId, role);
    }
    clientId = (
      await raw.client.create({
        data: { officeId, clientType: 'INDIVIDUAL', displayName: 'Folders client' },
      })
    ).id;
    other = await seedUser(await seedOffice('Other folders office'), 'OFFICE_MANAGER');
    users['other'] = other;
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

  it('should give a new file its default folders, system folders first in their order', async () => {
    const fileId = await openFile();
    await folder(fileId, { name: 'Drafts' });
    const folders = await list(fileId);
    expect(folders.map((row) => row.systemKey)).toEqual([...FOLDER_SYSTEM_KEYS, null]);
    expect(folders[0]).toMatchObject({ parentId: null, name: null, documentCount: 0 });
    expect(folders.at(-1)).toMatchObject({ name: 'Drafts', systemKey: null });
  });

  it('should create nested folders, count live documents and audit the creation', async () => {
    const fileId = await openFile();
    const parent = await folder(fileId, { name: 'Expert reports' }, 'trainee');
    const child = await folder(fileId, { name: 'تقارير', parentId: parent.id });
    expect(child).toMatchObject({ parentId: parent.id, name: 'تقارير', documentCount: 0 });
    await seedDocument(fileId, child.id);
    await seedDocument(fileId, child.id, true);
    const listed = (await list(fileId)).find((row) => row.id === child.id);
    expect(listed?.documentCount).toBe(1);
    expect(
      await raw.auditLog.findFirst({
        where: { entityType: 'DocumentFolder', entityId: parent.id, action: 'CREATE' },
      }),
    ).toMatchObject({ userId: user('trainee').userId, newValues: { name: 'Expert reports' } });
  });

  it('should refuse a sibling with the same normalised name (409) but allow it elsewhere', async () => {
    const fileId = await openFile();
    const parent = await folder(fileId, { name: 'أدلة' });
    expectError(
      await http().post(path(fileId)).set(as('lawyer')).send({ name: ' ادلة ' }),
      409,
      'RES-002',
    );
    await folder(fileId, { name: 'أدلة', parentId: parent.id });
  });

  it('should refuse an unknown parent, a move into its own subtree and nesting deeper than 5 levels', async () => {
    const fileId = await openFile();
    const otherFile = await openFile();
    const foreign = await folder(otherFile, { name: 'Foreign' });
    expectError(
      await http().post(path(fileId)).set(as('lawyer')).send({ name: 'X', parentId: foreign.id }),
      400,
      'VAL-001',
      'parentId',
    );
    let parentId: string | undefined;
    const chain: FolderBody[] = [];
    for (let level = 1; level <= 5; level += 1) {
      const created = await folder(fileId, { name: `L${level}`, ...(parentId && { parentId }) });
      chain.push(created);
      parentId = created.id;
    }
    const [top, second, , , deepest] = chain as [
      FolderBody,
      FolderBody,
      FolderBody,
      FolderBody,
      FolderBody,
    ];
    expectError(
      await http().post(path(fileId)).set(as('lawyer')).send({ name: 'L6', parentId: deepest.id }),
      400,
      'VAL-001',
      'parentId',
    );
    expectError(
      await http().patch(path(fileId, top.id)).set(as('lawyer')).send({ parentId: deepest.id }),
      400,
      'VAL-001',
      'parentId',
    );
    // Moving the 4-level subtree under another root folder would make it 5 + 1 deep.
    const side = await folder(fileId, { name: 'Side' });
    const sideChild = await folder(fileId, { name: 'Side child', parentId: side.id });
    expectError(
      await http()
        .patch(path(fileId, second.id))
        .set(as('lawyer'))
        .send({ parentId: sideChild.id }),
      400,
      'VAL-001',
      'parentId',
    );
  });

  it('should rename and move a folder, writing only what changed to the audit log', async () => {
    const fileId = await openFile();
    const a = await folder(fileId, { name: 'A' });
    const b = await folder(fileId, { name: 'B' });
    const res = await http()
      .patch(path(fileId, b.id))
      .set(as('lawyer'))
      .send({ name: 'B2', parentId: a.id })
      .expect(200);
    expect((res.body as { data: FolderBody }).data).toMatchObject({ name: 'B2', parentId: a.id });
    expect(
      await raw.auditLog.findFirst({ where: { entityId: b.id, action: 'UPDATE' } }),
    ).toMatchObject({
      oldValues: { name: 'B', parentId: null },
      newValues: { name: 'B2', parentId: a.id },
    });
    await http().patch(path(fileId, b.id)).set(as('lawyer')).send({ parentId: null }).expect(200);
    await http().patch(path(fileId, b.id)).set(as('lawyer')).send({ name: 'B2' }).expect(200);
    expect(await raw.auditLog.count({ where: { entityId: b.id, action: 'UPDATE' } })).toBe(2);
  });

  it('should keep default folders fixed (BIZ-014)', async () => {
    const fileId = await openFile();
    const [pleadings] = await list(fileId);
    const id = (pleadings as FolderBody).id;
    expectError(
      await http().patch(path(fileId, id)).set(as('lawyer')).send({ name: 'Mine' }),
      422,
      'BIZ-014',
    );
    expectError(await http().delete(path(fileId, id)).set(as('lawyer')), 422, 'BIZ-014');
  });

  it('should delete only an empty folder; soft-deleted documents move to the root', async () => {
    const fileId = await openFile();
    const parent = await folder(fileId, { name: 'Parent' });
    const child = await folder(fileId, { name: 'Child', parentId: parent.id });
    expectError(await http().delete(path(fileId, parent.id)).set(as('lawyer')), 422, 'BIZ-013');
    const live = await seedDocument(fileId, child.id);
    expectError(await http().delete(path(fileId, child.id)).set(as('lawyer')), 422, 'BIZ-013');
    await raw.document.update({ where: { id: live.id }, data: { deletedAt: new Date() } });
    await http().delete(path(fileId, child.id)).set(as('lawyer')).expect(204);
    expect(await raw.document.findUnique({ where: { id: live.id } })).toMatchObject({
      folderId: null,
    });
    expect(
      await raw.auditLog.findFirst({ where: { entityId: child.id, action: 'DELETE' } }),
    ).toMatchObject({ oldValues: { name: 'Child', parentId: parent.id } });
  });

  it('should apply permissions: read with the file, organise with upload:document, delete with delete:document', async () => {
    const fileId = await openFile();
    const created = await folder(fileId, { name: 'Trainee folder' }, 'trainee');
    expectError(await http().delete(path(fileId, created.id)).set(as('trainee')), 403, 'AUTH-100');
    // Not assigned to the file: it does not exist for them.
    expectError(await http().get(path(fileId)).set(as('outsider')), 404, 'RES-001');
    expectError(
      await http().post(path(fileId)).set(as('outsider')).send({ name: 'X' }),
      404,
      'RES-001',
    );
    await http().delete(path(fileId, created.id)).set(as('lawyer')).expect(204);
  });

  it('should let ADMIN staff list folders but not organise them (no upload:document)', async () => {
    const fileId = await openFile();
    const mine = await folder(fileId, { name: 'Lawyer folder' });
    expect(await list(fileId, 'admin')).toHaveLength(FOLDER_SYSTEM_KEYS.length + 1);
    expectError(
      await http().post(path(fileId)).set(as('admin')).send({ name: 'X' }),
      403,
      'AUTH-100',
    );
    expectError(
      await http().patch(path(fileId, mine.id)).set(as('admin')).send({ name: 'X' }),
      403,
      'AUTH-100',
    );
  });

  it('should hide the folders of a confidential file from an unassigned senior lawyer (D-096)', async () => {
    const fileId = await openFile();
    await raw.legalFile.update({ where: { id: fileId }, data: { isConfidential: true } });
    expectError(await http().get(path(fileId)).set(as('senior')), 404, 'RES-001');
    expectError(
      await http().post(path(fileId)).set(as('senior')).send({ name: 'X' }),
      404,
      'RES-001',
    );
    expect(await list(fileId, 'lawyer')).toHaveLength(FOLDER_SYSTEM_KEYS.length);
  });

  it('should let only one of two concurrent same-name creates win', async () => {
    const fileId = await openFile();
    const send = () => http().post(path(fileId)).set(as('lawyer')).send({ name: 'Racing' });
    const statuses = (await Promise.all([send(), send()])).map((res) => res.status).sort();
    expect(statuses).toEqual([201, 409]);
    expect(await raw.documentFolder.count({ where: { fileId, name: 'Racing' } })).toBe(1);
  });

  it('should refuse changes on an archived file (BIZ-007) but still list its folders', async () => {
    const fileId = await openFile();
    const created = await folder(fileId, { name: 'Before archive' });
    await raw.legalFile.update({ where: { id: fileId }, data: { status: 'ARCHIVED' } });
    expect(await list(fileId)).toHaveLength(FOLDER_SYSTEM_KEYS.length + 1);
    expectError(
      await http().post(path(fileId)).set(as('manager')).send({ name: 'X' }),
      422,
      'BIZ-007',
    );
    expectError(
      await http().patch(path(fileId, created.id)).set(as('manager')).send({ name: 'Y' }),
      422,
      'BIZ-007',
    );
    expectError(await http().delete(path(fileId, created.id)).set(as('manager')), 422, 'BIZ-007');
  });

  it("should answer 404 RES-001 for another office's file and folders, and a folder of another file", async () => {
    const fileId = await openFile();
    const mine = await folder(fileId, { name: 'Mine' });
    const otherFile = await openFile();
    const theirs = { ...other };
    const before = await raw.documentFolder.findUnique({ where: { id: mine.id } });
    for (const call of [
      () => http().get(path(fileId)).set(bearerFor(jwt, theirs)),
      () => http().post(path(fileId)).set(bearerFor(jwt, theirs)).send({ name: 'X' }),
      () => http().patch(path(fileId, mine.id)).set(bearerFor(jwt, theirs)).send({ name: 'X' }),
      () => http().delete(path(fileId, mine.id)).set(bearerFor(jwt, theirs)),
      () => http().patch(path(otherFile, mine.id)).set(as('lawyer')).send({ name: 'X' }),
      () => http().delete(path(otherFile, mine.id)).set(as('lawyer')),
      () => http().get(path('not-a-uuid')).set(as('lawyer')),
    ]) {
      expectError(await call(), 404, 'RES-001');
    }
    expect(await raw.documentFolder.findUnique({ where: { id: mine.id } })).toEqual(before);
  });

  it('should validate the body', async () => {
    const fileId = await openFile();
    expectError(
      await http().post(path(fileId)).set(as('lawyer')).send({ name: '' }),
      400,
      'VAL-001',
      'name',
    );
    const created = await folder(fileId, { name: 'Valid' });
    expectError(
      await http().patch(path(fileId, created.id)).set(as('lawyer')).send({}),
      400,
      'VAL-001',
    );
    for (const body of [
      { name: 'x'.repeat(101) },
      { name: 'a‮b' },
      { name: 'X', parentId: 'nope' },
    ]) {
      expectError(await http().post(path(fileId)).set(as('lawyer')).send(body), 400, 'VAL-001');
    }
  });
});
