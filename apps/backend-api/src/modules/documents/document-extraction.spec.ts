import { Readable } from 'node:stream';

import type { ClsService } from 'nestjs-cls';
import type { PinoLogger } from 'nestjs-pino';

import { DocumentAccessService } from './document-access.service';
import { DocumentExtraction } from './document-extraction';
import type { DocumentRecordsService } from './document-records.service';
import { DocumentRetry } from './document-retry';
import { MIME } from './extraction/extract-text';
import { buildDocx, buildPdf } from './extraction/fixtures.test-helper';
import { ocr } from './extraction/ocr';
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
import type { ClientInfo } from '../auth/client-info';

jest.mock('./extraction/ocr', () => ({
  ...jest.requireActual<object>('./extraction/ocr'),
  ocr: jest.fn(),
}));
const mockedOcr = jest.mocked(ocr);

const JOB = { documentId: '01920000-0000-7000-8000-0000000000d1', versionNumber: 2 };
const WORDS = Array.from({ length: 600 }, (_, i) => `word${i}`).join(' ');
const VERSION = {
  storageKey: 'k',
  mimeType: MIME.DOCX,
  createdById: 'u2',
  document: { officeId: 'o1', fileId: 'f1', documentType: 'PLEADING', name: 'Lease.docx' },
};

function extractionSetup({
  version = VERSION as unknown,
  updated = 1,
  autoSummary = 'false',
  body = buildDocx([WORDS]),
  enableOcr = true as boolean | null,
} = {}) {
  const tx = {
    document: { updateMany: jest.fn().mockResolvedValue({ count: updated }) },
    documentText: { upsert: jest.fn() },
  };
  const db = {
    documentVersion: { findFirst: jest.fn().mockResolvedValue(version) },
    document: { updateMany: jest.fn().mockResolvedValue({ count: updated }) },
    officeSettings: { findFirst: jest.fn().mockResolvedValue({ enableOcr }) },
  };
  const realtime = { toUser: jest.fn() };
  const queues = { enqueue: jest.fn() };
  const storage = { getStream: jest.fn().mockResolvedValue(Readable.from([body])) };
  const logger = { setContext: jest.fn(), info: jest.fn() };
  const service = new DocumentExtraction(
    { db } as unknown as PrismaService,
    {
      run: (work: (t: unknown, after: (task: () => unknown) => void) => unknown) =>
        work(tx, (task) => void task()),
    } as unknown as UnitOfWork,
    storage as unknown as StorageService,
    realtime as unknown as RealtimePublisher,
    queues as unknown as QueueProducer,
    new AppConfig(parseEnv(testEnv({ AI_AUTO_SUMMARY: autoSummary }))),
    logger as unknown as PinoLogger,
  );
  return { service, tx, db, realtime, queues, storage, logger };
}

const LIVE_PROCESSING = {
  id: JOB.documentId,
  currentVersion: 2,
  status: 'PROCESSING',
  deletedAt: null,
};

describe('DocumentExtraction', () => {
  it('should store the text, make the document READY and tell the uploader of the version', async () => {
    const { service, tx, db, realtime, logger } = extractionSetup();
    await expect(service.run(JOB)).resolves.toBe('READY');
    expect(db.documentVersion.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { ...JOB, document: LIVE_PROCESSING } }),
    );
    expect(tx.document.updateMany).toHaveBeenCalledWith({
      where: LIVE_PROCESSING,
      data: { status: 'READY', ocrStatus: 'DONE', processingErrorCode: null },
    });
    expect(tx.documentText.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ officeId: 'o1', ocrEngine: 'docx', versionNumber: 2 }),
      }),
    );
    expect(realtime.toUser).toHaveBeenCalledWith('u2', 'document.processed', {
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

  it('should change nothing for a version no longer processed, nor when the document moved on meanwhile', async () => {
    const gone = extractionSetup({ version: null });
    await expect(gone.service.run(JOB)).resolves.toBe('SUPERSEDED');
    expect(gone.storage.getStream).not.toHaveBeenCalled();
    const raced = extractionSetup({ updated: 0 });
    await expect(raced.service.run(JOB)).resolves.toBe('SUPERSEDED');
    expect(raced.tx.documentText.upsert).not.toHaveBeenCalled();
    expect(raced.realtime.toUser).not.toHaveBeenCalled();
  });

  it('should run images and scanned PDFs through OCR and keep the per-page confidence (D-139)', async () => {
    mockedOcr.mockResolvedValue({
      text: 'محكمة بداية رام الله',
      pageCount: 2,
      confidence: 88.5,
      pageConfidences: [91, null],
    });
    const image = extractionSetup({ version: { ...VERSION, mimeType: 'image/png' } });
    await expect(image.service.run(JOB)).resolves.toBe('READY');
    expect(mockedOcr).toHaveBeenLastCalledWith(expect.any(Buffer), 'image/png', {
      maxPages: 50,
      signal: expect.any(AbortSignal),
    });
    expect(image.tx.documentText.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          ocrEngine: 'tesseract',
          pageCount: 2,
          ocrConfidence: 88.5,
          pageConfidences: [91, null],
        }),
      }),
    );
    const scan = extractionSetup({
      version: { ...VERSION, mimeType: MIME.PDF },
      body: buildPdf(['p. 1', 'p. 2', 'p. 3']),
    });
    await expect(scan.service.run(JOB)).resolves.toBe('READY');
    expect(mockedOcr).toHaveBeenLastCalledWith(expect.any(Buffer), MIME.PDF, {
      maxPages: 50,
      pdfPageCount: 3,
      signal: expect.any(AbortSignal),
    });
  });

  it('should make a legacy .doc READY without text and without downloading it', async () => {
    const doc = extractionSetup({ version: { ...VERSION, mimeType: 'application/msword' } });
    await expect(doc.service.run(JOB)).resolves.toBe('NO_TEXT');
    expect(doc.storage.getStream).not.toHaveBeenCalled();
    expect(doc.tx.document.updateMany).toHaveBeenCalledWith({
      where: LIVE_PROCESSING,
      data: { status: 'READY', ocrStatus: 'NOT_NEEDED', processingErrorCode: null },
    });
    expect(doc.tx.documentText.upsert).not.toHaveBeenCalled();
    expect(doc.realtime.toUser).toHaveBeenCalledTimes(1);
  });

  it('should skip OCR for an office that switched it off', async () => {
    mockedOcr.mockClear();
    const off = extractionSetup({
      version: { ...VERSION, mimeType: 'image/jpeg' },
      enableOcr: false,
    });
    await expect(off.service.run(JOB)).resolves.toBe('NO_TEXT');
    expect(mockedOcr).not.toHaveBeenCalled();
    expect(off.storage.getStream).not.toHaveBeenCalled();
    expect(off.tx.documentText.upsert).not.toHaveBeenCalled();
  });

  it('should stop when the attempt was aborted', async () => {
    const { service, tx } = extractionSetup();
    const controller = new AbortController();
    controller.abort();
    await expect(service.run(JOB, controller.signal)).rejects.toThrow();
    expect(tx.document.updateMany).not.toHaveBeenCalled();
  });

  it('should mark a failed extraction FAILED with its code and tell the uploader, live and in-app', async () => {
    const { service, db, realtime, queues } = extractionSetup();
    await service.markFailed(JOB, 'VAL-005');
    expect(db.document.updateMany).toHaveBeenCalledWith({
      where: LIVE_PROCESSING,
      data: { status: 'FAILED', processingErrorCode: 'VAL-005' },
    });
    expect(realtime.toUser).toHaveBeenCalledTimes(1);
    expect(queues.enqueue).toHaveBeenCalledWith(
      'notification',
      'create-notification',
      expect.objectContaining({
        userId: 'u2',
        type: 'DOCUMENT_FAILED',
        params: { documentId: JOB.documentId, name: 'Lease.docx', code: 'VAL-005' },
      }),
      expect.anything(),
    );
    await service.markFailed(JOB);
    expect(db.document.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: { status: 'FAILED', processingErrorCode: 'EXT-002' } }),
    );
    const gone = extractionSetup({ version: null });
    await gone.service.markFailed(JOB);
    const raced = extractionSetup({ updated: 0 });
    await raced.service.markFailed(JOB);
    expect([...gone.realtime.toUser.mock.calls, ...raced.realtime.toUser.mock.calls]).toHaveLength(
      0,
    );
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
  const client: ClientInfo = { ip: '127.0.0.1', userAgent: null, requestId: null };

  it('should send a failed extraction back to extraction and a failed scan back to the scan', async () => {
    const extraction = retrySetup({
      status: 'FAILED',
      currentVersion: 2,
      processingErrorCode: 'EXT-002',
    });
    await expect(extraction.retry.retry(JOB.documentId, client)).resolves.toBe('document');
    expect(extraction.tx.document.updateMany).toHaveBeenCalledWith({
      where: { id: JOB.documentId, status: 'FAILED', deletedAt: null },
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
    // An unreadable file (VAL-005) would only fail again.
    const unreadable = retrySetup({
      status: 'FAILED',
      currentVersion: 1,
      processingErrorCode: 'VAL-005',
    });
    await expect(unreadable.retry.retry(JOB.documentId, client)).rejects.toMatchObject({
      code: 'BIZ-016',
    });
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
