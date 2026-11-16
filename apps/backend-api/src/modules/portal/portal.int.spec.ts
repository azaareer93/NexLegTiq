import { randomUUID } from 'node:crypto';

import { JwtService } from '@nestjs/jwt';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import type {
  PortalDocument,
  PortalFile,
  PortalFileDetail,
  PortalInvitation,
  PortalSession,
} from '@nexlegtiq/shared-contracts';
import request from 'supertest';

import { AppModule } from '../../app/app.module';
import { configureApp } from '../../app/configure-app';
import { hashOpaqueToken } from '../../common/auth/opaque-token';
import { QueueProducer } from '../../common/queue/queue-producer';
import { StorageService } from '../../common/storage/storage.service';
import { integrationEnv } from '../../config/env.fixture';
import { PrismaService } from '../../database/prisma.service';
import { TENANT_MODELS } from '../../database/tenant-models';
import type { PrismaClient } from '../../generated/prisma/client';
import { bearerFor } from '../auth/auth.test-helper';
import { liveSubscription } from '../subscriptions/subscription.test-helper';

type Delegate = { deleteMany(args: unknown): Promise<unknown> };
const dataOf = <T>(res: request.Response) => (res.body as { data: T }).data;
const codeOf = (res: request.Response) => (res.body as { error: { code: string } }).error.code;

/** The portal's data routes (MVP-98, D-186) on real PostgreSQL: what a client sees, and nothing more. */
describe('portal data (HTTP + PostgreSQL)', () => {
  let app: NestExpressApplication;
  let raw: PrismaClient;
  let jwt: JwtService;
  const officeIds: string[] = [];
  const emails: string[] = [];
  const savedEnv = { ...process.env };
  const http = () => request(app.getHttpServer());

  async function office() {
    const created = await raw.office.create({
      data: {
        name: `Portal data ${randomUUID().slice(0, 4)}`,
        settings: { create: {} },
        subscriptions: liveSubscription(),
      },
    });
    officeIds.push(created.id);
    const user = await raw.user.create({
      data: {
        officeId: created.id,
        fullName: 'Rami Lawyer',
        email: `mgr-${randomUUID()}@example.test`,
        phone: '+970599000000',
        passwordHash: '!',
        role: 'OFFICE_MANAGER',
      },
    });
    const client = () =>
      raw.client.create({
        data: { officeId: created.id, clientType: 'INDIVIDUAL', displayName: 'Client' },
      });
    const o = { officeId: created.id, userId: user.id, role: 'OFFICE_MANAGER' as const };
    return { ...o, clients: [await client(), await client()] as const };
  }

  async function file(o: Awaited<ReturnType<typeof office>>, clientId: string) {
    const row = await raw.legalFile.create({
      data: {
        officeId: o.officeId,
        fileNumber: `P-${randomUUID().slice(0, 8)}`,
        title: 'Lease dispute',
        description: 'Internal strategy',
        fileType: 'LITIGATION',
        responsibleLawyerId: o.userId,
        jurisdiction: 'PALESTINE',
        currency: 'ILS',
        hourlyRate: '300',
      },
    });
    await raw.fileClient.create({
      data: { officeId: o.officeId, fileId: row.id, clientId, isPrimary: true },
    });
    await raw.caseTimelineEvent.createMany({
      data: (['FILE_OPENED', 'TASK_COMPLETED'] as const).map((eventType) => ({
        officeId: o.officeId,
        fileId: row.id,
        eventType,
        payload: { name: 'secret' },
      })),
    });
    return row;
  }

  async function document(
    o: Awaited<ReturnType<typeof office>>,
    fileId: string,
    extra: object = {},
  ) {
    const stored = {
      originalFilename: 'عقد.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 100n,
      checksumSha256: 'c'.repeat(64),
      storageKey: `${o.officeId}/${fileId}/${randomUUID()}.pdf`,
    };
    const row = await raw.document.create({
      data: {
        officeId: o.officeId,
        fileId,
        name: 'Contract',
        ...stored,
        status: 'READY',
        uploadedById: o.userId,
        ...extra,
      },
    });
    await raw.documentVersion.create({
      data: {
        officeId: o.officeId,
        documentId: row.id,
        versionNumber: 1,
        createdById: o.userId,
        ...stored,
      },
    });
    return row;
  }

  /** Invites an address to the client and accepts: the portal access token. */
  async function portalUser(
    o: Awaited<ReturnType<typeof office>>,
    clientId: string,
  ): Promise<string> {
    const email = `portal-${randomUUID()}@example.test`;
    emails.push(email);
    const created = await http()
      .post(`/api/v1/clients/${clientId}/portal-invitations`)
      .set(bearerFor(jwt, o))
      .send({ email })
      .expect(201);
    const token = randomUUID().replaceAll('-', '');
    await raw.clientInvitation.update({
      where: { id: dataOf<PortalInvitation>(created).id },
      data: { tokenHash: hashOpaqueToken(token) },
    });
    const accepted = await http()
      .post('/api/v1/portal/auth/accept-invite')
      .send({
        token,
        fullName: 'Layla',
        password: 'Correct-Horse-42',
        acceptTerms: true,
        acceptPrivacy: true,
      })
      .expect(201);
    return `Bearer ${dataOf<PortalSession>(accepted).accessToken}`;
  }

  beforeAll(async () => {
    Object.assign(process.env, integrationEnv(), {
      JWT_PORTAL_SECRET: 'integration-only-portal-secret-0123456789abcdef',
      CLIENT_PORTAL_URL: 'http://localhost:4202',
    });
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideProvider(QueueProducer)
      .useValue({ enqueue: jest.fn().mockResolvedValue(undefined), remove: jest.fn() })
      .compile();
    app = module.createNestApplication<NestExpressApplication>({ bufferLogs: true });
    configureApp(app);
    await app.init();
    jest
      .spyOn(app.get(StorageService), 'presignedGetUrl')
      .mockResolvedValue('https://storage.test/x');
    // unscoped: test fixtures across offices.
    raw = app.get(PrismaService).unscoped();
    jwt = app.get(JwtService);
  }, 60_000);

  afterAll(async () => {
    if (raw) {
      const where = { officeId: { in: officeIds } };
      for (const model of [...TENANT_MODELS].filter((name) => name !== 'User').reverse()) {
        const delegate = (raw as unknown as Record<string, Delegate>)[
          model.charAt(0).toLowerCase() + model.slice(1)
        ];
        await delegate?.deleteMany({ where });
      }
      await raw.user.deleteMany({ where });
      await raw.subscription.deleteMany({ where });
      await raw.office.deleteMany({ where: { id: { in: officeIds } } });
      await raw.clientUser.deleteMany({ where: { email: { in: emails } } });
    }
    await app?.close();
    process.env = savedEnv;
  });

  it("should show a client its own files and shared documents, never another client's or the office's internals", async () => {
    const o = await office();
    const other = await office();
    const [clientA, clientB] = o.clients;
    const mine = await file(o, clientA.id);
    const sameOffice = await file(o, clientB.id);
    const otherOffice = await file(other, other.clients[0].id);
    const shared = await document(o, mine.id, { sharedWithClient: true });
    const unshared = await document(o, mine.id);
    const scanning = await document(o, mine.id, { sharedWithClient: true, status: 'SCANNING' });
    const auth = await portalUser(o, clientA.id);
    const as = (path: string) => http().get(`/api/v1/portal${path}`).set('Authorization', auth);

    const files = dataOf<PortalFile[]>(await as('/files').expect(200));
    expect(files.map((f) => f.id)).toEqual([mine.id]);
    expect(Object.keys(files[0] ?? {}).sort()).toEqual(
      [
        'fileNumber',
        'id',
        'lawyerName',
        'nextHearing',
        'officeId',
        'officeName',
        'status',
        'title',
      ].sort(),
    );
    expect(files[0]).toMatchObject({ lawyerName: 'Rami Lawyer', nextHearing: null });

    const detail = dataOf<PortalFileDetail>(await as(`/files/${mine.id}`).expect(200));
    expect(detail.timeline).toEqual([{ eventType: 'FILE_OPENED', occurredAt: expect.any(String) }]);
    expect(JSON.stringify(detail)).not.toMatch(/Internal strategy|secret|\+970|300/);
    for (const id of [sameOffice.id, otherOffice.id, randomUUID()]) {
      expect(codeOf(await as(`/files/${id}`).expect(404))).toBe('RES-001');
      await as(`/files/${id}/documents`).expect(404);
    }
    await as('/files/not-a-uuid').expect(404);

    const documents = dataOf<PortalDocument[]>(await as(`/files/${mine.id}/documents`).expect(200));
    expect(documents.map((d) => d.id)).toEqual([shared.id]);
    for (const id of [unshared.id, scanning.id]) await as(`/documents/${id}/download`).expect(404);
    expect(
      dataOf<{ downloadUrl: string }>(await as(`/documents/${shared.id}/download`).expect(200))
        .downloadUrl,
    ).toBe('https://storage.test/x');
    const audit = await raw.auditLog.findMany({
      where: { officeId: o.officeId, entityId: shared.id, action: 'DOWNLOAD' },
    });
    expect(audit).toEqual([
      expect.objectContaining({ userId: null, clientUserId: expect.any(String) }),
    ]);

    // An office token never passes the portal guard.
    await http().get('/api/v1/portal/files').set(bearerFor(jwt, o)).expect(401);
  });

  it('should let the office share and unshare a document, audited, with a timeline event', async () => {
    const o = await office();
    const mine = await file(o, o.clients[0].id);
    const doc = await document(o, mine.id);
    const auth = await portalUser(o, o.clients[0].id);
    const listed = async () =>
      dataOf<PortalDocument[]>(
        await http()
          .get(`/api/v1/portal/files/${mine.id}/documents`)
          .set('Authorization', auth)
          .expect(200),
      ).map((d) => d.id);

    const res = await http()
      .post(`/api/v1/documents/${doc.id}/share`)
      .set(bearerFor(jwt, o))
      .expect(200);
    expect(dataOf<{ sharedWithClient: boolean }>(res).sharedWithClient).toBe(true);
    expect(await listed()).toEqual([doc.id]);
    await http().post(`/api/v1/documents/${doc.id}/share`).set(bearerFor(jwt, o)).expect(200);
    await http().post(`/api/v1/documents/${doc.id}/unshare`).set(bearerFor(jwt, o)).expect(200);
    expect(await listed()).toEqual([]);

    const events = await raw.caseTimelineEvent.count({
      where: { fileId: mine.id, eventType: 'DOCUMENT_SHARED' },
    });
    expect(events).toBe(1);
    const audits = await raw.auditLog.findMany({
      where: { officeId: o.officeId, entityId: doc.id, action: 'UPDATE' },
      orderBy: { occurredAt: 'asc' },
    });
    expect(audits.map((a) => a.newValues)).toEqual([
      { sharedWithClient: true },
      { sharedWithClient: false },
    ]);

    // Another office's document is 404; a paralegal may not share (share:document is OM, SL, L).
    const other = await office();
    await http().post(`/api/v1/documents/${doc.id}/share`).set(bearerFor(jwt, other)).expect(404);
    const paralegal = await raw.user.create({
      data: {
        officeId: o.officeId,
        fullName: 'P',
        email: `p-${randomUUID()}@example.test`,
        passwordHash: '!',
        role: 'PARALEGAL',
      },
    });
    await http()
      .post(`/api/v1/documents/${doc.id}/share`)
      .set(bearerFor(jwt, { officeId: o.officeId, userId: paralegal.id, role: 'PARALEGAL' }))
      .expect(403);
  });
});
