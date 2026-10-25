import { OnWorkerEvent, Processor } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { OnApplicationBootstrap } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import type { Job } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';

import { QUEUE, workerOptions } from '../../../common/queue/queues';
import { parseTenantJob } from '../../../common/queue/tenant-job';
import type { TenantJobData } from '../../../common/queue/tenant-job';
import { TenantProcessor } from '../../../common/queue/tenant-processor';
import { TenantRunner } from '../../../common/tenancy/tenant-runner';
import { AppConfig } from '../../../config/app-config';
import { PrismaService } from '../../../database/prisma.service';
import { DocumentExtraction } from '../document-extraction';
import type { ProcessingFailure } from '../document-extraction';
import { DocumentJobSchema, PROCESS_DOCUMENT_JOB, SCAN_DOCUMENT_JOB } from '../document-jobs';
import type { DocumentJob } from '../document-jobs';
import { DocumentScan } from '../document-scan';
import { UnreadableDocumentError } from '../extraction/extract-text';

/**
 * The single consumer of the `ocr` queue (D-126, D-132):
 * - `scan-document`: the ClamAV scan of an uploaded version (`DocumentScan`); after the last failed attempt the
 *   document is FAILED;
 * - `process-document`: text extraction and Tesseract OCR (`DocumentExtraction`, D-139); an unreadable file fails at once
 *   (no retry would help), other errors are retried; after the last failed attempt the document is FAILED with EXT-002.
 * Concurrency and the attempt timeout come from `OCR_WORKER_CONCURRENCY` / `OCR_JOB_TIMEOUT_MS` when set.
 */
@Injectable()
@Processor(QUEUE.OCR, workerOptions(QUEUE.OCR))
export class OcrProcessor extends TenantProcessor<DocumentJob> implements OnApplicationBootstrap {
  protected readonly schema = DocumentJobSchema;

  constructor(
    tenant: TenantRunner,
    prisma: PrismaService,
    logger: PinoLogger,
    private readonly scan: DocumentScan,
    private readonly extraction: DocumentExtraction,
    private readonly config: AppConfig,
  ) {
    super(tenant, prisma, logger);
  }

  onApplicationBootstrap(): void {
    const { concurrency } = this.config.ocr;
    if (concurrency) this.worker.concurrency = concurrency;
  }

  protected override timeoutMs(policyMs: number): number {
    return this.config.ocr.timeoutMs ?? policyMs;
  }

  protected async handle(
    job: Job<DocumentJob & TenantJobData>,
    signal: AbortSignal,
  ): Promise<unknown> {
    const { documentId, versionNumber } = job.data;
    if (job.name === SCAN_DOCUMENT_JOB) {
      return { outcome: await this.scan.run({ documentId, versionNumber }, signal) };
    }
    if (job.name === PROCESS_DOCUMENT_JOB) {
      try {
        return { outcome: await this.extraction.run({ documentId, versionNumber }, signal) };
      } catch (error) {
        if (!(error instanceof UnreadableDocumentError)) throw error;
        // The parser's own message stays in the log; the job carries the code only.
        this.logger.warn({ documentId, err: error.cause }, error.message);
        throw new UnrecoverableError(UNREADABLE);
      }
    }
    throw new UnrecoverableError(`Unknown ocr job ${job.name}`);
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job | undefined, error: Error): Promise<void> {
    const mark = job && this.markerFor(job.name);
    if (!job || !mark || !isFinalAttempt(job, error)) return;
    const code =
      error instanceof UnrecoverableError && error.message === UNREADABLE ? UNREADABLE : 'EXT-002';
    const tenant = parseTenantJob(job.data);
    const fields = DocumentJobSchema.safeParse(job.data);
    if (!tenant || !fields.success) return;
    try {
      await this.tenant.run({ officeId: tenant.officeId }, () => mark(fields.data, code));
    } catch (markError) {
      this.logger.error(
        { err: markError, documentId: fields.data.documentId },
        'Document not marked FAILED',
      );
    }
  }

  /** Who marks a job FAILED after its last attempt: the scan or the extraction. */
  private markerFor(
    name: string,
  ): ((job: DocumentJob, code: ProcessingFailure) => Promise<void>) | null {
    if (name === SCAN_DOCUMENT_JOB) return (job) => this.scan.markFailed(job);
    return name === PROCESS_DOCUMENT_JOB
      ? (job, code) => this.extraction.markFailed(job, code)
      : null;
  }
}

/** The code of a file no parser can read (VAL-005: not what its type says): FAILED for good, no retry endpoint either. */
const UNREADABLE = 'VAL-005';

/**
 * An error that is not retried, the last attempt, or a job BullMQ gave up on after stalling (the worker was blocked or
 * died): otherwise the document would stay PROCESSING forever.
 */
function isFinalAttempt(job: Job, error: Error): boolean {
  return (
    error.name === 'UnrecoverableError' ||
    /stalled more than allowable limit/i.test(error.message) ||
    job.attemptsMade >= (job.opts.attempts ?? 1)
  );
}
