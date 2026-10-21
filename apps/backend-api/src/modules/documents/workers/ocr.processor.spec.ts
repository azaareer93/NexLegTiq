import { UnrecoverableError } from 'bullmq';
import type { Job } from 'bullmq';
import type { PinoLogger } from 'nestjs-pino';

import { OcrProcessor } from './ocr.processor';
import type { TenantRunner } from '../../../common/tenancy/tenant-runner';
import { AppConfig } from '../../../config/app-config';
import { testEnv } from '../../../config/env.fixture';
import { parseEnv } from '../../../config/env.schema';
import type { PrismaService } from '../../../database/prisma.service';
import type { DocumentExtraction } from '../document-extraction';
import type { DocumentScan } from '../document-scan';
import { UnreadableDocumentError } from '../extraction/extract-text';

const DATA = {
  officeId: '01920000-0000-7000-8000-0000000000a1',
  requestId: null,
  documentId: '01920000-0000-7000-8000-0000000000d1',
  versionNumber: 1,
};

function setup(env: Record<string, string> = {}) {
  const scan = {
    run: jest.fn().mockResolvedValue('CLEAN'),
    markFailed: jest.fn().mockResolvedValue(undefined),
  };
  const extraction = {
    run: jest.fn().mockResolvedValue('READY'),
    markFailed: jest.fn().mockResolvedValue(undefined),
  };
  const tenant = { run: jest.fn((_ctx: unknown, work: () => Promise<unknown>) => work()) };
  const logger = { error: jest.fn(), warn: jest.fn() };
  const processor = new OcrProcessor(
    tenant as unknown as TenantRunner,
    {} as PrismaService,
    logger as unknown as PinoLogger,
    scan as unknown as DocumentScan,
    extraction as unknown as DocumentExtraction,
    new AppConfig(parseEnv(testEnv(env))),
  );
  return { processor, scan, extraction, tenant, logger };
}

const job = (name: string, attemptsMade = 0) =>
  ({ name, data: DATA, attemptsMade, opts: { attempts: 3 } }) as unknown as Job;

type Internals = {
  handle(job: Job, signal: AbortSignal): Promise<unknown>;
  timeoutMs(policyMs: number): number;
  worker: { concurrency: number };
};

describe('OcrProcessor', () => {
  const signal = new AbortController().signal;

  it('should scan, extract text and refuse unknown jobs', async () => {
    const { processor, scan, extraction } = setup();
    const handle = (name: string) => (processor as unknown as Internals).handle(job(name), signal);
    await expect(handle('scan-document')).resolves.toEqual({ outcome: 'CLEAN' });
    expect(scan.run).toHaveBeenCalledWith(
      { documentId: DATA.documentId, versionNumber: 1 },
      signal,
    );
    await expect(handle('process-document')).resolves.toEqual({ outcome: 'READY' });
    expect(extraction.run).toHaveBeenCalledWith(
      { documentId: DATA.documentId, versionNumber: 1 },
      signal,
    );
    await expect(handle('other')).rejects.toThrow('Unknown ocr job other');
  });

  it('should fail an unreadable file at once and let other extraction errors be retried', async () => {
    const { processor, extraction } = setup();
    const handle = () =>
      (processor as unknown as Internals).handle(job('process-document'), signal);
    extraction.run.mockRejectedValueOnce(new UnreadableDocumentError('pdf'));
    await expect(handle()).rejects.toBeInstanceOf(UnrecoverableError);
    extraction.run.mockRejectedValueOnce(new Error('storage down'));
    await expect(handle()).rejects.toThrow('storage down');
  });

  it('should mark the failed step FAILED only after its last attempt', async () => {
    const { processor, scan, extraction, logger } = setup();
    await processor.onFailed(job('scan-document', 1), new Error('clamd down'));
    await processor.onFailed(job('process-document', 2), new Error('storage down'));
    await processor.onFailed(job('other', 3), new Error('x'));
    await processor.onFailed(undefined, new Error('x'));
    expect(scan.markFailed).not.toHaveBeenCalled();
    expect(extraction.markFailed).not.toHaveBeenCalled();
    await processor.onFailed(job('scan-document', 3), new Error('clamd down'));
    expect(scan.markFailed).toHaveBeenCalledWith({ documentId: DATA.documentId, versionNumber: 1 });
    await processor.onFailed(job('process-document', 0), new UnrecoverableError('VAL-005'));
    expect(extraction.markFailed).toHaveBeenCalledWith(
      { documentId: DATA.documentId, versionNumber: 1 },
      'VAL-005',
    );
    // A job BullMQ gave up on after stalling is final too (else the document stays PROCESSING).
    await processor.onFailed(
      job('process-document', 1),
      new Error('job stalled more than allowable limit'),
    );
    expect(extraction.markFailed).toHaveBeenLastCalledWith(
      { documentId: DATA.documentId, versionNumber: 1 },
      'EXT-002',
    );
    scan.markFailed.mockRejectedValueOnce(new Error('db down'));
    await processor.onFailed(job('scan-document', 0), new UnrecoverableError('bad'));
    expect(logger.error).toHaveBeenCalled();
  });

  it('should take concurrency and the attempt timeout from the configuration when set', () => {
    const configured = setup({
      OCR_WORKER_CONCURRENCY: '3',
      OCR_JOB_TIMEOUT_MS: '45000',
    }).processor;
    const internals = configured as unknown as Internals;
    Object.defineProperty(configured, 'worker', { value: { concurrency: 1 } });
    configured.onApplicationBootstrap();
    expect(internals.worker.concurrency).toBe(3);
    expect(internals.timeoutMs(120_000)).toBe(45_000);
    const defaults = setup().processor;
    Object.defineProperty(defaults, 'worker', { value: { concurrency: 2 } });
    defaults.onApplicationBootstrap();
    expect((defaults as unknown as Internals).worker.concurrency).toBe(2);
    expect((defaults as unknown as Internals).timeoutMs(120_000)).toBe(120_000);
  });
});
