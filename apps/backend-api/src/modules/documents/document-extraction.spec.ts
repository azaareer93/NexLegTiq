import { Readable } from 'node:stream';

import type { ClsService } from 'nestjs-cls';
import type { PinoLogger } from 'nestjs-pino';

import { DocumentAccessService } from './document-access.service';
import { DocumentExtraction } from './document-extraction';
import type { DocumentRecordsService } from './document-records.service';
import { DocumentRetry } from './document-retry';
import { MIME } from './extraction/extract-text';
import { buildDocx } from './extraction/fixtures.test-helper';
import type { UploadIntake } from './upload/upload-intake';
import type { RequestContext } from '../../common/context/request-context';
import type { QueueProducer } from '../../common/queue/queue-producer';
import type { RealtimePublisher } from '../../common/realtime/realtime.publisher';
import type { StorageService } from '../../common/storage/storage.service';
import { AppConfig } from '../../config/app-config';
import { testEnv } from '../../config/env.fixture';
import { parseEnv } from '../../config/env.schema';
import type { PrismaService } from '../../database/prisma.service';
import type { UnitOfWork } from '../../database/unit-of-work';

const JOB = { documentId: '01920000-0000-7000-8000-0000000000d1', versionNumber: 2 };
const WORDS = Array.from({ length: 600 }, (_, i) => `word${i}`).join(' ');

function extractionSetup({
  version = {
    storageKey: 'k',
    mimeType: MIME.DOCX,
    document: {
      status: 'PROCESSING',
      currentVersion: 2,
      fileId: 'f1',
      uploadedById: 'u1',
      documentType: 'PLEADING',
    },
  } as unknown,
  updated = 1,
  autoSummary = 'false',
  body = buildDocx([WORDS]),
} = {}) {
  const tx = {
    document: {
      updateMany: jest.fn().mockResolvedValue({ count: updated }),
      findFirstOrThrow: jest.fn().mockResolvedValue({ officeId: 'o1' }),
    },
    documentText: { upsert: jest.fn() },
  };
  const db = {
    documentVersion: { findFirst: jest.fn().mockResolvedValue(version) },
    document: {
      findFirst: jest.fn().mockResolvedValue({ uploadedById: 'u1', fileId: 'f1' }),
      updateMany: jest.fn().mockResolvedValue({ count: updated }),
    },
  };
  const realtime = { toUser: jest.fn() };
  const logger = { setContext: jest.fn(), info: jest.fn() };
  const service = new DocumentExtraction(
    { db } as unknown as PrismaService,
    {
      run: (work: (t: unknown, after: (task: () => unknown) => void) => unknown) =>
        work(tx, (task) => void task()),
    } as unknown as UnitOfWork,
    { getStream: jest.fn().mockResolvedValue(Readable.from([body])) } as unknown as StorageService,
    realtime as unknown as RealtimePublisher,
    new AppConfig(parseEnv(testEnv({ AI_AUTO_SUMMARY: autoSummary }))),
    logger as unknown as PinoLogger,
  );
  return { service, tx, db, realtime, logger };
}

describe('DocumentExtraction', () => {
  it('should store the text, make the document READY and tell the uploader', async () => {
    const { service, tx, realtime, logger } = extractionSetup();
    await expect(service.run(JOB)).resolves.toBe('READY');
    expect(tx.document.updateMany).toHaveBeenCalledWith({
      where: { id: JOB.documentId, currentVersion: 2, status: 'PROCESSING' },
      data: { status: 'READY', ocrStatus: 'DONE', processingErrorCode: null },
    });
    expect(tx.documentText.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ officeId: 'o1', ocrEngine: 'docx', versionNumber: 2 }),
      }),
    );
    expect(realtime.toUser).toHaveBeenCalledWith('u1', 'document.processed', {
      documentId: JOB.documentId,
      fileId: 'f1',
    });
    expect(logger.info).not.toHaveBeenCalledWith(expect.anything(), 'Auto-summary wanted');
  });

  it('should note an auto-summary when switched on', async () => {
    const { service, logger } = extractionSetup({ autoSummary: 'true' });
    await service.run(JOB);
    expect(logger.info).toHaveBeenCalledWith({ documentId: JOB.documentId }, 'Auto-summary wanted');
  });

  it.each([
    ['no version', null],
    [
      'a document not processing',
      { storageKey: 'k', mimeType: MIME.DOCX, document: { status: 'READY', currentVersion: 2 } },
    ],
    [
      'an older version',
      {
        storageKey: 'k',
        mimeType: MIME.DOCX,
        document: { status: 'PROCESSING', currentVersion: 3 },
      },
    ],
  ])('should change nothing for %s', async (_label, version) => {
    const { service, tx } = extractionSetup({ version });
    await expect(service.run(JOB)).resolves.toBe('SUPERSEDED');
    expect(tx.document.updateMany).not.toHaveBeenCalled();
  });

  it('should leave images for OCR and do nothing when the version moved on during extraction', async () => {
    const image = extractionSetup({
      version: {
        storageKey: 'k',
        mimeType: 'image/png',
        document: { status: 'PROCESSING', currentVersion: 2 },
      },
    });
    await expect(image.service.run(JOB)).resolves.toBe('NEEDS_OCR');
    const raced = extractionSetup({ updated: 0 });
    await expect(raced.service.run(JOB)).resolves.toBe('SUPERSEDED');
    expect(raced.tx.documentText.upsert).not.toHaveBeenCalled();
    expect(raced.realtime.toUser).not.toHaveBeenCalled();
  });

  it('should mark a failed extraction FAILED with EXT-002 and tell the uploader, only once', async () => {
    const { service, db, realtime } = extractionSetup();
    await service.markFailed(JOB);
    expect(db.document.updateMany).toHaveBeenCalledWith({
      where: { id: JOB.documentId, currentVersion: 2, status: 'PROCESSING' },
      data: { status: 'FAILED', processingErrorCode: 'EXT-002' },
    });
    expect(realtime.toUser).toHaveBeenCalledTimes(1);
    const already = extractionSetup({ updated: 0 });
    await already.service.markFailed(JOB);
    expect(already.realtime.toUser).not.toHaveBeenCalled();
  });
});

describe('DocumentRetry', () => {
  function retrySetup(row: unknown, updated = 1) {
    const tx = {
      document: {
        findFirst: jest.fn().mockResolvedValue(row),
        updateMany: jest.fn().mockResolvedValue({ count: updated }),
      },
      auditLog: { create: jest.fn() },
    };
    const queues = { enqueue: jest.fn() };
    const access = Object.create(DocumentAccessService.prototype) as DocumentAccessService;
    access.assertDocumentAccess = jest.fn().mockResolvedValue({ fileId: 'f1' });
    const context: Record<string, unknown> = { userId: 'u1', officeId: 'o1' };
    const retry = new DocumentRetry(
      { get: (key: string) => context[key] } as unknown as ClsService<RequestContext>,
      access,
      { get: jest.fn().mockResolvedValue('document') } as unknown as DocumentRecordsService,
      { recheck: jest.fn() } as unknown as UploadIntake,
      {
        run: (work: (t: unknown, after: (task: () => unknown) => void) => unknown) =>
          work(tx, (task) => void task()),
      } as unknown as UnitOfWork,
      queues as unknown as QueueProducer,
    );
    return { retry, tx, queues, context };
  }
  const client = { ip: null, userAgent: null, requestId: null };

  it('should send a failed extraction back to extraction and a failed scan back to the scan', async () => {
    const extraction = retrySetup({
      status: 'FAILED',
      currentVersion: 2,
      processingErrorCode: 'EXT-002',
    });
    await expect(extraction.retry.retry(JOB.documentId, client)).resolves.toBe('document');
    expect(extraction.tx.document.updateMany).toHaveBeenCalledWith({
      where: { id: JOB.documentId, status: 'FAILED' },
      data: { status: 'PROCESSING', processingErrorCode: null },
    });
    expect(extraction.queues.enqueue).toHaveBeenCalledWith('ocr', 'process-document', JOB, {
      jobId: expect.stringMatching(/^process-.*-v2-retry-\d+$/),
    });
    const scan = retrySetup({ status: 'FAILED', currentVersion: 2, processingErrorCode: null });
    await scan.retry.retry(JOB.documentId, client);
    expect(scan.queues.enqueue).toHaveBeenCalledWith(
      'ocr',
      'scan-document',
      JOB,
      expect.anything(),
    );
  });

  it('should refuse anything but a failed document, also when another retry won the race', async () => {
    await expect(
      retrySetup({ status: 'READY' }).retry.retry(JOB.documentId, client),
    ).rejects.toMatchObject({ code: 'BIZ-016' });
    await expect(retrySetup(null).retry.retry(JOB.documentId, client)).rejects.toMatchObject({
      code: 'BIZ-016',
    });
    const raced = retrySetup({ status: 'FAILED', currentVersion: 1, processingErrorCode: null }, 0);
    await expect(raced.retry.retry(JOB.documentId, client)).rejects.toMatchObject({
      code: 'BIZ-016',
    });
    expect(raced.queues.enqueue).not.toHaveBeenCalled();
  });

  it('should need a caller in the context', async () => {
    const { retry, context } = retrySetup({
      status: 'FAILED',
      currentVersion: 1,
      processingErrorCode: null,
    });
    delete context['userId'];
    await expect(retry.retry(JOB.documentId, client)).rejects.toThrow('No office caller');
  });
});
