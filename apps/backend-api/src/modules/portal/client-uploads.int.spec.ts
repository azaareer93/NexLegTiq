import { randomUUID } from 'node:crypto';

import { JwtService } from '@nestjs/jwt';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import type {
  ClientUpload,
  PortalInvitation,
  PortalSession,
  PortalUpload,
} from '@nexlegtiq/shared-contracts';
import type { OfficeId, Role } from '@nexlegtiq/shared-types';
import { ClsService } from 'nestjs-cls';
import type { PinoLogger } from 'nestjs-pino';
import request from 'supertest';

import { AppModule } from '../../app/app.module';
import { configureApp } from '../../app/configure-app';
import { hashOpaqueToken } from '../../common/auth/opaque-token';
import { QueueProducer } from '../../common/queue/queue-producer';
import { StorageService } from '../../common/storage/storage.service';
import { TenantRunner } from '../../common/tenancy/tenant-runner';
import { AppConfig } from '../../config/app-config';
import { integrationEnv } from '../../config/env.fixture';
import { PrismaService } from '../../database/prisma.service';
import { TENANT_MODELS } from '../../database/tenant-models';
import { UnitOfWork } from '../../database/unit-of-work';
import type { PrismaClient } from '../../generated/prisma/client';
import { bearerFor } from '../auth/auth.test-helper';
import { MAX_PENDING_CLIENT_BYTES } from '../documents/client-upload-intake';
import { ClientUploadScan } from '../documents/client-upload-scan';
import { ClamavScanner } from '../documents/upload/clamav-scanner';
import type { NotificationService } from '../notifications/notification.service';
import { liveSubscription } from '../subscriptions/subscription.test-helper';

type Delegate = { deleteMany(args: unknown): Promise<unknown> };
const dataOf = <T>(res: request.Response) => (res.body as { data: T }).data;
const codeOf = (res: request.Response) => (res.body as { error: { code: string } }).error.code;
/** The EICAR anti-virus test string: harmless, but every scanner reports it. */
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
const pdf = () => {
  const body = Buffer.alloc(2048, 0x20);
  body.write('%PDF-1.7\n');
  return body;
};

/** Client uploads (MVP-99, D-187) on real PostgreSQL, storage and ClamAV: portal upload → scan → office review. */
describe('client uploads (HTTP + PostgreSQL + ClamAV)', () => {
  let app: NestExpressApplication;
  let raw: PrismaClient;
  let jwt: JwtService;
  const officeIds: string[] = [];
  const emails: string[] = [];
  const savedEnv = { ...process.env };
  const http = () => request(app.getHttpServer());
  const notify = jest.fn().mockResolvedValue(undefined);

  async function office() {
    const created = await raw.office.create({
      data: {
        name: `Uploads ${randomUUID().slice(0, 4)}`,
        settings: { create: {} },
        subscriptions: liveSubscription(),
      },
    });
    officeIds.push(created.id);
    const user = (role: Role) =>
      raw.user.create({
        data: {
          officeId: created.id,
          fullName: `User ${role}`,
          email: `${role.toLowerCase()}-${randomUUID()}@example.test`,
          passwordHash: '!',
          role,
        },
      });
    const manager = await user('OFFICE_MANAGER');
    const client = (displayName: string) =>
      raw.client.create({ data: { officeId: created.id, clientType: 'INDIVIDUAL', displayName } });
    return {
      officeId: created.id,
      userId: manager.id,
      role: 'OFFICE_MANAGER' as const,
      clients: [await client('Layla Client'), await client('Other Client')] as const,
      user,
    };
  }
  type Office = Awaited<ReturnType<typeof office>>;

  async function file(o: Office, clientIds: string[]) {
    const row = await raw.legalFile.create({
      data: {
        officeId: o.officeId,
        fileNumber: `U-${randomUUID().slice(0, 8)}`,
        title: 'Lease dispute',
        fileType: 'LITIGATION',
        responsibleLawyerId: o.userId,
        jurisdiction: 'PALESTINE',
        currency: 'ILS',
      },
    });
    for (const [i, clientId] of clientIds.entries()) {
      await raw.fileClient.create({
        data: { officeId: o.officeId, fileId: row.id, clientId, isPrimary: i === 0 },
      });
    }
    return row;
  }

  async function portalUser(o: Office, clientId: string): Promise<string> {
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

  const send = (auth: string, fileId: string, body: Buffer, filename = 'عقد.pdf') =>
    http()
      .post(`/api/v1/portal/files/${fileId}/uploads`)
      .set('Authorization', auth)
      .attach('file', body, { filename, contentType: 'application/octet-stream' });

  /** Runs the worker's scan of an upload in its office, as the `ocr` queue would. */
  const scan = (o: Office, uploadId: string) =>
    app
      .get(TenantRunner)
      .run({ officeId: o.officeId as OfficeId }, () =>
        new ClientUploadScan(
          app.get(ClsService),
          app.get(PrismaService),
          app.get(UnitOfWork),
          app.get(StorageService),
          new ClamavScanner(app.get(AppConfig)),
          { notify } as unknown as NotificationService,
          { setContext: () => undefined, warn: () => undefined } as unknown as PinoLogger,
        ).run({ uploadId }, new AbortController().signal),
      );

  beforeAll(async () => {
    Object.assign(process.env, integrationEnv(), {
      JWT_PORTAL_SECRET: 'integration-only-portal-secret-0123456789abcdef',
      CLIENT_PORTAL_URL: 'http://localhost:4202',
      EMAIL_VERIFICATION_ENFORCED: 'false',
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

  it('should take a client upload through the scan into review, and file an accepted one as a document', async () => {
    const o = await office();
    const shared = await file(o, [o.clients[0].id, o.clients[1].id]);
    const layla = await portalUser(o, o.clients[0].id);
    const other = await portalUser(o, o.clients[1].id);

    const sent = await send(layla, shared.id, pdf()).expect(202);
    const upload = dataOf<PortalUpload>(sent);
    expect(upload).toMatchObject({
      name: 'عقد.pdf',
      status: 'SCANNING',
      mimeType: 'application/pdf',
    });
    const row = await raw.clientUpload.findUniqueOrThrow({ where: { id: upload.id } });
    expect(row.storageKey.startsWith(`${o.officeId}/${shared.id}/${upload.id}/`)).toBe(true);
    expect(
      await raw.auditLog.count({
        where: {
          entityId: upload.id,
          action: 'CREATE',
          userId: null,
          clientUserId: row.clientUserId,
        },
      }),
    ).toBe(1);
    // Never among the office's documents before it is accepted.
    expect(await raw.document.count({ where: { fileId: shared.id } })).toBe(0);

    await expect(scan(o, upload.id)).resolves.toBe('CLEAN');
    expect(notify).toHaveBeenCalledWith(
      [o.userId],
      expect.objectContaining({
        type: 'CLIENT_UPLOAD',
        params: { client: 'Layla Client', name: 'عقد.pdf' },
      }),
      expect.anything(),
    );

    const queue = dataOf<ClientUpload[]>(
      await http()
        .get(`/api/v1/cases/${shared.id}/client-uploads`)
        .set(bearerFor(jwt, o))
        .expect(200),
    );
    expect(queue).toEqual([
      expect.objectContaining({ id: upload.id, status: 'PENDING_REVIEW', uploaderName: 'Layla' }),
    ]);
    const link = await http()
      .get(`/api/v1/client-uploads/${upload.id}/download`)
      .set(bearerFor(jwt, o))
      .expect(200);
    expect(dataOf<{ downloadUrl: string }>(link).downloadUrl).toEqual(expect.any(String));

    // Another client of the same file never sees Layla's upload.
    const listedFor = async (auth: string) =>
      dataOf<PortalUpload[]>(
        await http()
          .get(`/api/v1/portal/files/${shared.id}/uploads`)
          .set('Authorization', auth)
          .expect(200),
      );
    expect(await listedFor(other)).toEqual([]);

    const accepted = await http()
      .post(`/api/v1/client-uploads/${upload.id}/accept`)
      .set(bearerFor(jwt, o))
      .send({ documentType: 'EVIDENCE' })
      .expect(200);
    const documentId = dataOf<ClientUpload>(accepted).documentId;
    const document = await raw.document.findUniqueOrThrow({
      where: { id: documentId ?? '' },
      include: { folder: true },
    });
    expect(document).toMatchObject({
      status: 'PROCESSING',
      documentType: 'EVIDENCE',
      uploadedById: o.userId,
      storageKey: row.storageKey,
      sharedWithClient: false,
    });
    expect(document.folder?.systemKey).toBe('CLIENT_UPLOADS');
    expect(
      await raw.caseTimelineEvent.count({
        where: { fileId: shared.id, eventType: 'DOCUMENT_UPLOADED' },
      }),
    ).toBe(1);
    expect(await listedFor(layla)).toEqual([expect.objectContaining({ status: 'ACCEPTED' })]);

    const again = await http()
      .post(`/api/v1/client-uploads/${upload.id}/reject`)
      .set(bearerFor(jwt, o))
      .send({ reason: 'Too late' })
      .expect(422);
    expect(codeOf(again)).toBe('BIZ-028');
  });

  it('should show the client why an upload was rejected, delete it, and quarantine malware', async () => {
    const o = await office();
    const mine = await file(o, [o.clients[0].id]);
    const layla = await portalUser(o, o.clients[0].id);

    const upload = dataOf<PortalUpload>(await send(layla, mine.id, pdf()).expect(202));
    const early = await http()
      .post(`/api/v1/client-uploads/${upload.id}/accept`)
      .set(bearerFor(jwt, o))
      .send({ documentType: 'OTHER' })
      .expect(422);
    expect(codeOf(early)).toBe('BIZ-015');
    await scan(o, upload.id);
    await http()
      .post(`/api/v1/client-uploads/${upload.id}/reject`)
      .set(bearerFor(jwt, o))
      .send({ reason: 'Please send the signed copy' })
      .expect(200);
    const listed = dataOf<PortalUpload[]>(
      await http()
        .get(`/api/v1/portal/files/${mine.id}/uploads`)
        .set('Authorization', layla)
        .expect(200),
    );
    expect(listed).toEqual([
      expect.objectContaining({
        status: 'REJECTED',
        rejectionReason: 'Please send the signed copy',
      }),
    ]);
    await http()
      .get(`/api/v1/client-uploads/${upload.id}/download`)
      .set(bearerFor(jwt, o))
      .expect(404);

    const infected = dataOf<PortalUpload>(
      await send(layla, mine.id, Buffer.from(EICAR), 'eicar.csv').expect(202),
    );
    await expect(scan(o, infected.id)).resolves.toBe('QUARANTINED');
    expect((await raw.clientUpload.findUniqueOrThrow({ where: { id: infected.id } })).status).toBe(
      'QUARANTINED',
    );
    expect(await raw.auditLog.count({ where: { entityId: infected.id, action: 'SECURITY' } })).toBe(
      1,
    );
  });

  it("should keep uploads within the client's files, the office's tenant and the reviewers' permissions", async () => {
    const o = await office();
    const other = await office();
    const mine = await file(o, [o.clients[0].id]);
    const notMine = await file(o, [o.clients[1].id]);
    const otherOffice = await file(other, [other.clients[0].id]);
    const layla = await portalUser(o, o.clients[0].id);

    for (const fileId of [notMine.id, otherOffice.id, randomUUID()]) {
      expect(codeOf(await send(layla, fileId, pdf()).expect(404))).toBe('RES-001');
      await http()
        .get(`/api/v1/portal/files/${fileId}/uploads`)
        .set('Authorization', layla)
        .expect(404);
    }
    await send(bearerFor(jwt, o).Authorization, mine.id, pdf()).expect(401);

    const upload = dataOf<PortalUpload>(await send(layla, mine.id, pdf()).expect(202));
    await scan(o, upload.id);
    // Another office: 404; a role without upload:document: 403; validation: 400.
    await http()
      .get(`/api/v1/cases/${mine.id}/client-uploads`)
      .set(bearerFor(jwt, other))
      .expect(404);
    await http()
      .post(`/api/v1/client-uploads/${upload.id}/accept`)
      .set(bearerFor(jwt, other))
      .send({ documentType: 'OTHER' })
      .expect(404);
    const admin = await o.user('ADMIN');
    await http()
      .post(`/api/v1/client-uploads/${upload.id}/reject`)
      .set(bearerFor(jwt, { officeId: o.officeId, userId: admin.id, role: 'ADMIN' }))
      .send({ reason: 'x' })
      .expect(403);
    await http()
      .post(`/api/v1/client-uploads/${upload.id}/reject`)
      .set(bearerFor(jwt, o))
      .send({ reason: '   ' })
      .expect(400);

    // The client's unreviewed uploads are capped (BIZ-027).
    await raw.clientUpload.update({
      where: { id: upload.id },
      data: { sizeBytes: MAX_PENDING_CLIENT_BYTES },
    });
    expect(codeOf(await send(layla, mine.id, pdf()).expect(422))).toBe('BIZ-027');
  });
});
