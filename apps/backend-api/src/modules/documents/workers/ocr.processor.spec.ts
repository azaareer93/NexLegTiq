import type { Job } from 'bullmq';
import type { PinoLogger } from 'nestjs-pino';

import { OcrProcessor } from './ocr.processor';
import type { TenantRunner } from '../../../common/tenancy/tenant-runner';
import type { PrismaService } from '../../../database/prisma.service';
import type { DocumentScan } from '../document-scan';

const DATA = {
  officeId: '01920000-0000-7000-8000-0000000000a1',
  requestId: null,
  documentId: '01920000-0000-7000-8000-0000000000d1',
  versionNumber: 1,
};

function setup() {
  const scan = {
    run: jest.fn().mockResolvedValue('CLEAN'),
    markFailed: jest.fn().mockResolvedValue(undefined),
  };
  const tenant = { run: jest.fn((_ctx: unknown, work: () => Promise<unknown>) => work()) };
  const logger = { error: jest.fn() };
  const processor = new OcrProcessor(
    tenant as unknown as TenantRunner,
    {} as PrismaService,
    logger as unknown as PinoLogger,
    scan as unknown as DocumentScan,
  );
  return { processor, scan, tenant, logger };
}

const job = (name: string, attemptsMade = 0) =>
  ({ name, data: DATA, attemptsMade, opts: { attempts: 3 } }) as unknown as Job;

type Handle = { handle(job: Job, signal: AbortSignal): Promise<unknown> };

describe('OcrProcessor', () => {
  const signal = new AbortController().signal;

  it('should scan, skip text extraction until it exists, and refuse unknown jobs', async () => {
    const { processor, scan } = setup();
    const handle = (name: string) => (processor as unknown as Handle).handle(job(name), signal);
    await expect(handle('scan-document')).resolves.toEqual({ outcome: 'CLEAN' });
    expect(scan.run).toHaveBeenCalledWith(
      { documentId: DATA.documentId, versionNumber: 1 },
      signal,
    );
    await expect(handle('process-document')).resolves.toEqual({
      skipped: 'TEXT_EXTRACTION_NOT_BUILT',
    });
    await expect(handle('other')).rejects.toThrow('Unknown ocr job other');
  });

  it('should mark the document FAILED only after the last attempt of a scan', async () => {
    const { processor, scan, logger } = setup();
    await processor.onFailed(job('scan-document', 1), new Error('clamd down'));
    expect(scan.markFailed).not.toHaveBeenCalled();
    await processor.onFailed(job('process-document', 3), new Error('x'));
    await processor.onFailed(undefined, new Error('x'));
    expect(scan.markFailed).not.toHaveBeenCalled();
    await processor.onFailed(job('scan-document', 3), new Error('clamd down'));
    expect(scan.markFailed).toHaveBeenCalledWith({ documentId: DATA.documentId, versionNumber: 1 });
    scan.markFailed.mockRejectedValueOnce(new Error('db down'));
    const unrecoverable = Object.assign(new Error('bad'), { name: 'UnrecoverableError' });
    await processor.onFailed(job('scan-document', 0), unrecoverable);
    expect(logger.error).toHaveBeenCalled();
  });
});
