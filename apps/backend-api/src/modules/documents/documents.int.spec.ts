import { createHash, randomUUID } from 'node:crypto';

import { JwtService } from '@nestjs/jwt';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import { MAX_UPLOAD_BYTES } from '@nexlegtiq/shared-contracts';
import type { OfficeId, Role } from '@nexlegtiq/shared-types';
import { ClsService } from 'nestjs-cls';
import type { PinoLogger } from 'nestjs-pino';
import request from 'supertest';

import { DocumentScan } from './document-scan';
import { ClamavScanner } from './upload/clamav-scanner';
import { AppModule } from '../../app/app.module';
import { configureApp } from '../../app/configure-app';
import { QueueProducer } from '../../common/queue/queue-producer';
import { getQueue, QUEUE } from '../../common/queue/queues';
import { StorageService } from '../../common/storage/storage.service';
import { TenantRunner } from '../../common/tenancy/tenant-runner';
import { AppConfig } from '../../config/app-config';
import { integrationEnv } from '../../config/env.fixture';
import { PrismaService } from '../../database/prisma.service';
import { TENANT_MODELS } from '../../database/tenant-models';
import { UnitOfWork } from '../../database/unit-of-work';
import type { PrismaClient } from '../../generated/prisma/client';
import { bearerFor } from '../auth/auth.test-helper';
import { liveSubscription } from '../subscriptions/subscription.test-helper';

type Delegate = { deleteMany(args: unknown): Promise<unknown> };

interface SeededUser {
  readonly userId: string;
  readonly officeId: string;
  readonly role: Role;
}

interface Accepted {
  documentId: string;
  versionNumber: number;
  status: string;
}

const pdf = (bytes = 2048) => {
  const body = Buffer.alloc(bytes, 0x20);
  body.write('%PDF-1.7\n');
  return body;
};
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
/** The EICAR anti-virus test string: harmless, but every scanner reports it. */
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

/** MVP-72 on real PostgreSQL, RustFS, Redis and ClamAV: uploads, versions, the malware scan and access (D-126). */
describe('documents upload API (HTTP + PostgreSQL + storage + ClamAV)', () => {
  jest.setTimeout(120_000);
  let app: NestExpressApplication;
  let raw: PrismaClient;
  let jwt: JwtService;
  const officeIds: string[] = [];
  const savedEnv = { ...process.env };
  const users: Record<string, SeededUser> = {};
  let officeId: string;
  let clientId: string;
  let otherClientId: string;

  const http = () => request(app.getHttpServer());
  const user = (key: string) => users[key] as SeededUser;
  const as = (key: string) => bearerFor(jwt, user(key));
  const inOffice = <T>(office: string, work: () => Promise<T>) =>
    app.get(TenantRunner).run({ officeId: office as OfficeId }, work);

  async function seedOffice(name: string): Promise<string> {
    const office = await raw.office.create({
      data: { name, settings: { create: {} }, subscriptions: liveSubscription() },
    });
    officeIds.push(office.id);
    return office.id;
  }

  async function seedUser(office: string, role: Role): Promise<SeededUser> {
    const created = await raw.user.create({
      data: {
        officeId: office,
        fullName: `${role} user`,
        email: `documents-${randomUUID()}@example.test`,
        passwordHash: '!',
        role,
      },
    });
    return { userId: created.id, officeId: office, role };
  }

  async function openFile(key = 'manager'): Promise<string> {
    const res = await http()
      .post('/api/v1/cases')
      .set(as(key))
      .send({
        title: 'Documents test file',
        fileType: 'LITIGATION',
        clientIds: [clientId],
        primaryClientId: clientId,
        responsibleLawyerId: user('lawyer').userId,
      })
      .expect(201);
    return (res.body as { data: { id: string } }).data.id;
  }

  function upload(
    fileId: string,
    body: Buffer,
    filename: string,
    {
      key = 'lawyer',
      fields = {} as Record<string, string>,
      headers = {} as Record<string, string>,
    } = {},
  ) {
    let req = http().post('/api/v1/documents').set(as(key)).set(headers).field('fileId', fileId);
    for (const [name, value] of Object.entries(fields)) req = req.field(name, value);
    return req.attach('file', body, { filename, contentType: 'application/octet-stream' });
  }

  const accepted = (res: request.Response) => {
    expect(res.status).toBe(202);
    return (res.body as { data: Accepted }).data;
  };

  const expectError = (res: request.Response, status: number, code: string, field?: string) =>
    expect({ status: res.status, body: res.body as unknown }).toMatchObject({
      status,
      body: { error: { code, ...(field && { details: [expect.objectContaining({ field })] }) } },
    });

  const scanner = () =>
    new DocumentScan(
      app.get(ClsService),
      app.get(PrismaService),
      app.get(UnitOfWork),
      app.get(StorageService),
      new ClamavScanner(app.get(AppConfig)),
      app.get(QueueProducer),
      { setContext: () => undefined, warn: () => undefined } as unknown as PinoLogger,
    );

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
    officeId = await seedOffice('Documents office');
    for (const [key, role] of [
      ['manager', 'OFFICE_MANAGER'],
      ['lawyer', 'LAWYER'],
      ['senior', 'SENIOR_LAWYER'],
      ['admin', 'ADMIN'],
      ['trainee', 'TRAINEE'],
    ] as const) {
      users[key] = await seedUser(officeId, role);
    }
    clientId = (
      await raw.client.create({
        data: { officeId, clientType: 'INDIVIDUAL', displayName: 'Documents client' },
      })
    ).id;
    const otherOffice = await seedOffice('Other documents office');
    users['other'] = await seedUser(otherOffice, 'OFFICE_MANAGER');
    otherClientId = (
      await raw.client.create({
        data: { officeId: otherOffice, clientType: 'INDIVIDUAL', displayName: 'Other client' },
      })
    ).id;
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

  it('should stream a PDF with an Arabic name to storage, record it and queue its scan', async () => {
    const fileId = await openFile();
    const body = pdf();
    const res = await upload(fileId, body, 'عقد الإيجار.pdf', {
      fields: { documentType: 'PLEADING', isConfidential: 'false' },
    });
    const { documentId } = accepted(res);
    expect(accepted(res)).toEqual({ documentId, versionNumber: 1, status: 'SCANNING' });

    const document = await raw.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(document).toMatchObject({
      officeId,
      fileId,
      name: 'عقد الإيجار.pdf',
      originalFilename: 'عقد الإيجار.pdf',
      documentType: 'PLEADING',
      mimeType: 'application/pdf',
      sizeBytes: BigInt(body.length),
      checksumSha256: sha256(body),
      status: 'SCANNING',
      uploadedById: user('lawyer').userId,
    });
    expect(document.storageKey).toMatch(
      new RegExp(`^${officeId}/${fileId}/${documentId}/[0-9a-f-]{36}\\.pdf$`),
    );
    const stored = await inOffice(officeId, () =>
      app.get(StorageService).head(document.storageKey),
    );
    expect(stored?.size).toBe(body.length);
    expect(
      await raw.documentVersion.findFirst({ where: { documentId, versionNumber: 1 } }),
    ).toMatchObject({ storageKey: document.storageKey, createdById: user('lawyer').userId });
    expect(
      await raw.caseTimelineEvent.findFirst({ where: { sourceId: documentId } }),
    ).toMatchObject({ eventType: 'DOCUMENT_UPLOADED', payload: { versionNumber: 1 } });
    expect(
      await raw.auditLog.findFirst({ where: { entityId: documentId, action: 'CREATE' } }),
    ).toMatchObject({ entityType: 'Document' });
    const job = await getQueue(app, QUEUE.OCR).getJob(`${officeId}_scan-${documentId}-v1`);
    expect(job?.name).toBe('scan-document');
  });

  it('should judge the type by its bytes: a renamed executable and a PNG called .pdf are refused', async () => {
    const fileId = await openFile();
    const exe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(512)]);
    expectError(await upload(fileId, exe, 'invoice.pdf'), 415, 'VAL-005');
    expectError(await upload(fileId, PNG, 'scan.pdf'), 415, 'VAL-005');
    expectError(await upload(fileId, exe, 'list.csv'), 415, 'VAL-005');
    accepted(await upload(fileId, PNG, 'scan.png'));
    expect(await raw.document.count({ where: { fileId } })).toBe(1);
  });

  it('should accept exactly 50 MiB and refuse one byte more (413 VAL-006), keeping nothing', async () => {
    const fileId = await openFile();
    accepted(await upload(fileId, pdf(MAX_UPLOAD_BYTES), 'large.pdf'));
    expectError(await upload(fileId, pdf(MAX_UPLOAD_BYTES + 1), 'larger.pdf'), 413, 'VAL-006');
    expectError(
      await upload(fileId, pdf(MAX_UPLOAD_BYTES + 200_000), 'announced.pdf'),
      413,
      'VAL-006',
    );
    expect(await raw.document.count({ where: { fileId } })).toBe(1);
  });

  it('should validate the form: fields before the file, a file part, multipart only', async () => {
    const fileId = await openFile();
    const fileFirst = await http()
      .post('/api/v1/documents')
      .set(as('lawyer'))
      .attach('file', pdf(), 'a.pdf')
      .field('fileId', fileId);
    expectError(fileFirst, 400, 'VAL-001', 'fileId');
    expectError(
      await http().post('/api/v1/documents').set(as('lawyer')).field('fileId', fileId),
      400,
      'VAL-001',
      'file',
    );
    expectError(
      await http().post('/api/v1/documents').set(as('lawyer')).send({ fileId }),
      415,
      'VAL-005',
    );
    expectError(
      await upload(fileId, pdf(), 'a.pdf', { fields: { documentType: 'POSTER' } }),
      400,
      'VAL-001',
      'documentType',
    );
    expectError(await upload(fileId, pdf(), 'gpj\u202Eexe.pdf'), 400, 'VAL-001', 'file');
  });

  it('should return the first document for a repeated Idempotency-Key', async () => {
    const fileId = await openFile();
    const headers = { 'Idempotency-Key': `upload-${randomUUID()}` };
    const first = accepted(await upload(fileId, pdf(), 'a.pdf', { headers }));
    const again = accepted(await upload(fileId, pdf(4096), 'a.pdf', { headers }));
    expect(again.documentId).toBe(first.documentId);
    expect(await raw.document.count({ where: { fileId } })).toBe(1);
    expectError(
      await upload(fileId, pdf(), 'a.pdf', { headers: { 'Idempotency-Key': 'short' } }),
      400,
      'VAL-001',
      'Idempotency-Key',
    );
  });

  it('should check permission, the file, its folder and hearing, and archived files', async () => {
    const fileId = await openFile();
    expectError(await upload(fileId, pdf(), 'a.pdf', { key: 'admin' }), 403, 'AUTH-100');
    expectError(await upload(fileId, pdf(), 'a.pdf', { key: 'other' }), 404, 'RES-001');
    const otherFile = await openFile();
    const folder = await raw.documentFolder.findFirstOrThrow({ where: { fileId: otherFile } });
    expectError(
      await upload(fileId, pdf(), 'a.pdf', { fields: { folderId: folder.id } }),
      400,
      'VAL-001',
      'folderId',
    );
    expectError(
      await upload(fileId, pdf(), 'a.pdf', { fields: { sessionId: randomUUID() } }),
      400,
      'VAL-001',
      'sessionId',
    );
    const own = await raw.documentFolder.findFirstOrThrow({ where: { fileId } });
    const placed = accepted(await upload(fileId, pdf(), 'a.pdf', { fields: { folderId: own.id } }));
    expect(
      (await raw.document.findUniqueOrThrow({ where: { id: placed.documentId } })).folderId,
    ).toBe(own.id);
    await raw.legalFile.update({ where: { id: fileId }, data: { status: 'ARCHIVED' } });
    expectError(await upload(fileId, pdf(), 'a.pdf'), 422, 'BIZ-007');
  });

  it('should let only the uploader or an editor of the file replace a document, and scan the new version', async () => {
    const fileId = await openFile();
    await raw.fileTeamMember.create({ data: { officeId, fileId, userId: user('trainee').userId } });
    const lawyers = accepted(await upload(fileId, pdf(), 'brief.pdf'));
    const version = (documentId: string, key: string) =>
      http()
        .post(`/api/v1/documents/${documentId}/versions`)
        .set(as(key))
        .attach('file', pdf(), 'next.pdf');
    expectError(await version(lawyers.documentId, 'trainee'), 403, 'AUTH-100');
    const own = accepted(await upload(fileId, pdf(), 'notes.pdf', { key: 'trainee' }));
    expect(accepted(await version(own.documentId, 'trainee')).versionNumber).toBe(2);
    expect(
      await getQueue(app, QUEUE.OCR).getJob(`${officeId}_scan-${own.documentId}-v2`),
    ).toBeTruthy();
  });

  it('should not replay a key another uploader used, and refuse a folder of another office', async () => {
    const fileId = await openFile();
    const headers = { 'Idempotency-Key': `shared-${randomUUID()}` };
    const first = accepted(await upload(fileId, pdf(), 'a.pdf', { headers }));
    const second = accepted(await upload(fileId, pdf(), 'b.pdf', { key: 'manager', headers }));
    expect(second.documentId).not.toBe(first.documentId);
    const theirFile = (
      await http()
        .post('/api/v1/cases')
        .set(as('other'))
        .send({
          title: 'Their file',
          fileType: 'LITIGATION',
          clientIds: [otherClientId],
          primaryClientId: otherClientId,
          responsibleLawyerId: user('other').userId,
        })
        .expect(201)
    ).body as { data: { id: string } };
    const theirFolder = await raw.documentFolder.findFirstOrThrow({
      where: { fileId: theirFile.data.id },
    });
    expectError(
      await upload(fileId, pdf(), 'a.pdf', { fields: { folderId: theirFolder.id } }),
      400,
      'VAL-001',
      'folderId',
    );
  });

  it('should add versions, mirror the newest and list them newest first', async () => {
    const fileId = await openFile();
    const { documentId } = accepted(await upload(fileId, pdf(), 'draft.pdf'));
    const second = pdf(3000);
    const res = await http()
      .post(`/api/v1/documents/${documentId}/versions`)
      .set(as('manager'))
      .field('changeNote', 'Signed copy')
      .attach('file', second, 'signed.pdf');
    expect(accepted(res)).toEqual({ documentId, versionNumber: 2, status: 'SCANNING' });
    expect(await raw.document.findUniqueOrThrow({ where: { id: documentId } })).toMatchObject({
      currentVersion: 2,
      originalFilename: 'signed.pdf',
      checksumSha256: sha256(second),
      name: 'draft.pdf',
    });
    const list = await http()
      .get(`/api/v1/documents/${documentId}/versions`)
      .set(as('lawyer'))
      .expect(200);
    const versions = (
      list.body as {
        data: { versionNumber: number; changeNote: string | null; createdBy: { id: string } }[];
      }
    ).data;
    expect(versions.map((v) => v.versionNumber)).toEqual([2, 1]);
    expect(versions[0]).toMatchObject({
      changeNote: 'Signed copy',
      createdBy: { id: user('manager').userId },
    });
    expectError(
      await http().get(`/api/v1/documents/${documentId}/versions`).set(as('other')),
      404,
      'RES-001',
    );
    expectError(
      await http()
        .post(`/api/v1/documents/${documentId}/versions`)
        .set(as('other'))
        .attach('file', pdf(), 'x.pdf'),
      404,
      'RES-001',
    );
  });

  it('should hide a confidential document from colleagues who are not on the file', async () => {
    const fileId = await openFile();
    const { documentId } = accepted(
      await upload(fileId, pdf(), 'secret.pdf', { fields: { isConfidential: 'true' } }),
    );
    const versions = (key: string) =>
      http().get(`/api/v1/documents/${documentId}/versions`).set(as(key));
    expect((await versions('senior')).status).toBe(404);
    expect((await versions('manager')).status).toBe(200);
    expect((await versions('lawyer')).status).toBe(200);
    // Its name stays out of the file's timeline, which colleagues off the file may see.
    const event = await raw.caseTimelineEvent.findFirstOrThrow({ where: { sourceId: documentId } });
    expect(event.payload).toEqual({ versionNumber: 1 });
  });

  it('should pass a clean file on to processing and quarantine the EICAR test file', async () => {
    const fileId = await openFile();
    const clean = accepted(await upload(fileId, pdf(), 'clean.pdf'));
    const infected = accepted(await upload(fileId, Buffer.from(EICAR), 'eicar.csv'));
    const signal = new AbortController().signal;
    const scan = scanner();
    await expect(
      inOffice(officeId, () =>
        scan.run({ documentId: clean.documentId, versionNumber: 1 }, signal),
      ),
    ).resolves.toBe('CLEAN');
    await expect(
      inOffice(officeId, () =>
        scan.run({ documentId: infected.documentId, versionNumber: 1 }, signal),
      ),
    ).resolves.toBe('QUARANTINED');

    expect((await raw.document.findUniqueOrThrow({ where: { id: clean.documentId } })).status).toBe(
      'PROCESSING',
    );
    expect(
      await getQueue(app, QUEUE.OCR).getJob(`${officeId}_process-${clean.documentId}-v1`),
    ).toBeTruthy();
    const quarantined = await raw.document.findUniqueOrThrow({
      where: { id: infected.documentId },
    });
    expect(quarantined.status).toBe('QUARANTINED');
    await expect(
      inOffice(officeId, () => app.get(StorageService).head(quarantined.storageKey)),
    ).resolves.toBeNull();
    expect(
      await raw.auditLog.findFirst({
        where: { entityId: infected.documentId, action: 'SECURITY' },
      }),
    ).toMatchObject({ newValues: { event: 'MALWARE_DETECTED', versionNumber: 1 } });
    const notification = await getQueue(app, QUEUE.NOTIFICATION).getJob(
      `${officeId}_scan-${infected.documentId}-v1-quarantined`,
    );
    expect(notification?.data).toMatchObject({
      userId: user('lawyer').userId,
      titleKey: 'shell.notifications.documentQuarantined',
    });
  });
});
