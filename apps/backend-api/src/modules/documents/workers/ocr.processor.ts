import { OnWorkerEvent, Processor } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { OnApplicationBootstrap } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import type { Job } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { z } from 'zod';

import { QUEUE, workerOptions } from '../../../common/queue/queues';
import { parseTenantJob } from '../../../common/queue/tenant-job';
import type { TenantJobData } from '../../../common/queue/tenant-job';
import { TenantProcessor } from '../../../common/queue/tenant-processor';
import { TenantRunner } from '../../../common/tenancy/tenant-runner';
import { AppConfig } from '../../../config/app-config';
import { PrismaService } from '../../../database/prisma.service';
import { ClientUploadScan } from '../client-upload-scan';
import { DocumentExtraction } from '../document-extraction';
import type { ProcessingFailure } from '../document-extraction';
import {
  ClientUploadJobSchema,
  DocumentJobSchema,
  PROCESS_DOCUMENT_JOB,
  SCAN_CLIENT_UPLOAD_JOB,
  SCAN_DOCUMENT_JOB,
} from '../document-jobs';
import type { ClientUploadJob, DocumentJob } from '../document-jobs';
import { DocumentScan } from '../document-scan';
import { UnreadableDocumentError } from '../extraction/extract-text';

/**
 * The single consumer of the `ocr` queue (D-126, D-132):
 * - `scan-document`: the ClamAV scan of an uploaded version (`DocumentScan`); after the last failed attempt the
 *   document is FAILED;
 * - `process-document`: text extraction and Tesseract OCR (`DocumentExtraction`, D-139); an unreadable file fails at once
 *   (no retry would help), other errors are retried; after the last failed attempt the document is FAILED with EXT-002.
 * - `scan-client-upload`: the scan of a client's portal upload (`ClientUploadScan`, D-187); FAILED after the last attempt.
 * Concurrency and the attempt timeout come from `OCR_WORKER_CONCURRENCY` / `OCR_JOB_TIMEOUT_MS` when set.
 */
@Injectable()
@Processor(QUEUE.OCR, workerOptions(QUEUE.OCR))
export class OcrProcessor
  extends TenantProcessor<DocumentJob | ClientUploadJob>
  implements OnApplicationBootstrap
{
  protected readonly schema = z.union([DocumentJobSchema, ClientUploadJobSchema]);

  constructor(
    tenant: TenantRunner,
    prisma: PrismaService,
    logger: PinoLogger,
    private readonly scan: DocumentScan,
    private readonly uploadScan: ClientUploadScan,
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
    job: Job<(DocumentJob | ClientUploadJob) & TenantJobData>,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (job.name === SCAN_CLIENT_UPLOAD_JOB) {
      const upload = ClientUploadJobSchema.safeParse(job.data);
      if (!upload.success) throw new UnrecoverableError('Invalid job payload');
      return { outcome: await this.uploadScan.run(upload.data, signal) };
    }
    const parsed = DocumentJobSchema.safeParse(job.data);
    if (!parsed.success) throw new UnrecoverableError('Invalid job payload');
    const { documentId, versionNumber } = parsed.data;
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
    if (!tenant) return;
    try {
      await this.tenant.run({ officeId: tenant.officeId }, () => mark(job.data, code));
    } catch (markError) {
      this.logger.error(
        { err: markError, job: job.name, jobId: job.id },
        'Job target not marked FAILED',
      );
    }
  }

  /** Who marks a job's target FAILED after its last attempt: a scan or the extraction (payloads unread → nothing). */
  private markerFor(
    name: string,
  ): ((data: unknown, code: ProcessingFailure) => Promise<void>) | null {
    const document =
      (run: (job: DocumentJob, code: ProcessingFailure) => Promise<void>) =>
      async (data: unknown, code: ProcessingFailure) => {
        const fields = DocumentJobSchema.safeParse(data);
        if (fields.success) await run(fields.data, code);
      };
    if (name === SCAN_DOCUMENT_JOB) return document((job) => this.scan.markFailed(job));
    if (name === PROCESS_DOCUMENT_JOB) {
      return document((job, code) => this.extraction.markFailed(job, code));
    }
    if (name === SCAN_CLIENT_UPLOAD_JOB) {
      return async (data) => {
        const fields = ClientUploadJobSchema.safeParse(data);
        if (fields.success) await this.uploadScan.markFailed(fields.data);
      };
    }
    return null;
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
