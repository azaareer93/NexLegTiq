import { randomUUID } from 'node:crypto';

import { JwtService } from '@nestjs/jwt';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { OfficeId, Role } from '@nexlegtiq/shared-types';
import type { Queue } from 'bullmq';
import { ClsService } from 'nestjs-cls';
import type { PinoLogger } from 'nestjs-pino';
import request from 'supertest';

import { DocumentExtraction } from './document-extraction';
import { DocumentScan } from './document-scan';
import { buildDocx, buildPdf, buildXlsx } from './extraction/fixtures.test-helper';
import { ClamavScanner } from './upload/clamav-scanner';
import { AppModule } from '../../app/app.module';
import { configureApp } from '../../app/configure-app';
import { QueueProducer } from '../../common/queue/queue-producer';
import { getQueue, QUEUE } from '../../common/queue/queues';
import { RealtimePublisher } from '../../common/realtime/realtime.publisher';
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
type Person = { userId: string; officeId: string; role: Role };
type Job = { documentId: string; versionNumber: number };

const LINE =
  'The tenant shall pay the monthly rent of 1,250 ILS before the fifth day of each month.';
const quiet = {
  setContext: () => undefined,
  warn: () => undefined,
  info: () => undefined,
} as unknown as PinoLogger;

/** MVP-73 on real PostgreSQL, RustFS, Redis and ClamAV: upload → scan → extraction → READY, failures and retry (D-132). */
describe('document text extraction (integration)', () => {
  jest.setTimeout(120_000);
  let app: NestExpressApplication;
  let raw: PrismaClient;
  let jwt: JwtService;
  let manager: Person;
  let other: Person;
  let clientId: string;
  const officeIds: string[] = [];
  const savedEnv = { ...process.env };
  const http = () => request(app.getHttpServer());
  const inOffice = <T>(work: () => Promise<T>) =>
    app.get(TenantRunner).run({ officeId: manager.officeId as OfficeId }, work);

  const scanner = () =>
    new DocumentScan(
      app.get(ClsService),
      app.get(PrismaService),
      app.get(UnitOfWork),
      app.get(StorageService),
      new ClamavScanner(app.get(AppConfig)),
      app.get(QueueProducer),
      quiet,
    );
  const extraction = () =>
    new DocumentExtraction(
      app.get(PrismaService),
      app.get(UnitOfWork),
      app.get(StorageService),
      app.get(RealtimePublisher),
      app.get(AppConfig),
      quiet,
    );

  async function seed(name: string): Promise<Person> {
    const office = await raw.office.create({
      data: { name, settings: { create: {} }, subscriptions: liveSubscription() },
    });
    officeIds.push(office.id);
    const user = await raw.user.create({
      data: {
        officeId: office.id,
        fullName: 'Manager',
        email: `extract-${randomUUID()}@example.test`,
        passwordHash: '!',
        role: 'OFFICE_MANAGER',
      },
    });
    return { userId: user.id, officeId: office.id, role: 'OFFICE_MANAGER' };
  }

  /** Uploads through the API, then runs the scan as the worker would: the document is PROCESSING. */
  async function uploaded(body: Buffer, filename: string, documentType = 'PLEADING'): Promise<Job> {
    const file = await http()
      .post('/api/v1/cases')
      .set(bearerFor(jwt, manager))
      .send({
        title: 'Extraction file',
        fileType: 'LITIGATION',
        clientIds: [clientId],
        primaryClientId: clientId,
        responsibleLawyerId: manager.userId,
      })
      .expect(201);
    const res = await http()
      .post('/api/v1/documents')
      .set(bearerFor(jwt, manager))
      .field('fileId', (file.body as { data: { id: string } }).data.id)
      .field('documentType', documentType)
      .attach('file', body, { filename, contentType: 'application/octet-stream' })
      .expect(202);
    const job = (res.body as { data: Job }).data;
    const signal = new AbortController().signal;
    await expect(
      inOffice(() =>
        scanner().run({ documentId: job.documentId, versionNumber: job.versionNumber }, signal),
      ),
    ).resolves.toBe('CLEAN');
    return { documentId: job.documentId, versionNumber: job.versionNumber };
  }

  const document = (id: string, person = manager) =>
    http().get(`/api/v1/documents/${id}`).set(bearerFor(jwt, person));

  beforeAll(async () => {
    Object.assign(process.env, integrationEnv(), {
      EMAIL_VERIFICATION_ENFORCED: 'false',
      BULLMQ_PREFIX: `test-ext-${randomUUID().slice(0, 8)}`,
    });
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = module.createNestApplication<NestExpressApplication>({ bufferLogs: true });
    configureApp(app);
    await app.init();
    // unscoped: fixtures for two offices and checks of stored rows.
    raw = app.get(PrismaService).unscoped();
    jwt = app.get(JwtService);
    manager = await seed('Extraction office');
    other = await seed('Other extraction office');
    clientId = (
      await raw.client.create({
        data: {
          officeId: manager.officeId,
          clientType: 'INDIVIDUAL',
          displayName: 'Extraction client',
        },
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

  it.each([
    [
      'a PDF with a text layer',
      () => Promise.resolve(buildPdf([LINE, `Clause 7: termination. ${LINE}`])),
      'lease.pdf',
      'pdf-text-layer',
      2,
    ],
    [
      'a Word document',
      () => Promise.resolve(buildDocx(['عقد إيجار بين الطرفين', LINE])),
      'عقد.docx',
      'docx',
      null,
    ],
    ['a workbook', () => buildXlsx({ Payments: [['Rent', LINE]] }), 'payments.xlsx', 'xlsx', null],
  ])(
    'should turn %s into searchable text and a READY document',
    async (_label, body, filename, engine, pages) => {
      const job = await uploaded(await body(), filename);
      await expect(inOffice(() => extraction().run(job))).resolves.toBe('READY');
      const res = await document(job.documentId).expect(200);
      expect(res.body.data).toMatchObject({
        status: 'READY',
        ocrStatus: 'DONE',
        processingErrorCode: null,
      });
      const text = await http()
        .get(`/api/v1/documents/${job.documentId}/text`)
        .set(bearerFor(jwt, manager))
        .expect(200);
      expect((text.body as { data: { text: string } }).data.text).toContain('monthly rent');
      const [row] = await raw.$queryRaw<
        { engine: string; pages: number | null; indexed: boolean }[]
      >`
      SELECT ocr_engine AS engine, page_count AS pages, search_vector_simple @@ plainto_tsquery('simple', 'monthly rent') AS indexed
      FROM document_texts WHERE document_id = ${job.documentId}::uuid`;
      expect(row).toEqual({ engine, pages, indexed: true });
      // Running again (a retried job) changes nothing.
      await expect(inOffice(() => extraction().run(job))).resolves.toBe('SUPERSEDED');
    },
  );

  it('should leave a scan-like PDF waiting for OCR', async () => {
    const job = await uploaded(buildPdf(['p. 1']), 'scan.pdf');
    await expect(inOffice(() => extraction().run(job))).resolves.toBe('NEEDS_OCR');
    const res = await document(job.documentId).expect(200);
    expect(res.body.data).toMatchObject({ status: 'PROCESSING', ocrStatus: 'PENDING' });
  });

  it('should mark a failed extraction FAILED with EXT-002 and run it again on retry, once', async () => {
    const job = await uploaded(buildPdf([LINE]), 'broken.pdf');
    await inOffice(() => extraction().markFailed(job));
    await expect(document(job.documentId).expect(200)).resolves.toMatchObject({
      body: { data: { status: 'FAILED', processingErrorCode: 'EXT-002' } },
    });
    const retry = (person = manager) =>
      http().post(`/api/v1/documents/${job.documentId}/ocr/retry`).set(bearerFor(jwt, person));
    const res = await retry().expect(202);
    expect(res.body.data).toMatchObject({ status: 'PROCESSING', processingErrorCode: null });
    const queued = await (getQueue(app, QUEUE.OCR) as Queue).getJobs(['waiting', 'delayed']);
    expect(
      queued.some(
        (queuedJob) =>
          queuedJob.name === 'process-document' && queuedJob.data.documentId === job.documentId,
      ),
    ).toBe(true);
    await expect(retry()).resolves.toMatchObject({
      status: 422,
      body: { error: { code: 'BIZ-016' } },
    });
    await expect(retry(other)).resolves.toMatchObject({
      status: 404,
      body: { error: { code: 'RES-001' } },
    });
    const audit = await raw.auditLog.findFirst({
      where: { entityId: job.documentId, newValues: { path: ['retried'], equals: true } },
    });
    expect(audit?.oldValues).toEqual({ status: 'FAILED', processingErrorCode: 'EXT-002' });
  });

  it('should send a failed scan back to the scan on retry', async () => {
    const job = await uploaded(buildPdf([LINE]), 'scan-failed.pdf');
    // A scan that failed for good leaves the document FAILED without a processing error code.
    await raw.document.update({ where: { id: job.documentId }, data: { status: 'FAILED' } });
    const res = await http()
      .post(`/api/v1/documents/${job.documentId}/ocr/retry`)
      .set(bearerFor(jwt, manager))
      .expect(202);
    expect(res.body.data).toMatchObject({ status: 'SCANNING' });
    const queued = await (getQueue(app, QUEUE.OCR) as Queue).getJobs(['waiting', 'delayed']);
    expect(
      queued.some(
        (queuedJob) =>
          queuedJob.name === 'scan-document' && queuedJob.data.documentId === job.documentId,
      ),
    ).toBe(true);
  });
});
