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
import { DocumentJobSchema, PROCESS_DOCUMENT_JOB, SCAN_DOCUMENT_JOB } from '../document-jobs';
import type { DocumentJob } from '../document-jobs';
import { DocumentScan } from '../document-scan';
import { UnreadableDocumentError } from '../extraction/extract-text';

/**
 * The single consumer of the `ocr` queue (D-126, D-132):
 * - `scan-document`: the ClamAV scan of an uploaded version (`DocumentScan`); after the last failed attempt the
 *   document is FAILED;
 * - `process-document`: text extraction (`DocumentExtraction`); an unreadable file fails at once (no retry would help),
 *   other errors are retried; after the last failed attempt the document is FAILED with EXT-002.
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
        return { outcome: await this.extraction.run({ documentId, versionNumber }) };
      } catch (error) {
        if (error instanceof UnreadableDocumentError) throw new UnrecoverableError(error.message);
        throw error;
      }
    }
    throw new UnrecoverableError(`Unknown ocr job ${job.name}`);
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job | undefined, error: Error): Promise<void> {
    const mark = job && this.markerFor(job.name);
    if (!job || !mark || !isFinalAttempt(job, error)) return;
    const tenant = parseTenantJob(job.data);
    const fields = DocumentJobSchema.safeParse(job.data);
    if (!tenant || !fields.success) return;
    try {
      await this.tenant.run({ officeId: tenant.officeId }, () => mark.markFailed(fields.data));
    } catch (markError) {
      this.logger.error(
        { err: markError, documentId: fields.data.documentId },
        'Document not marked FAILED',
      );
    }
  }

  /** Who marks a job FAILED after its last attempt: the scan or the extraction. */
  private markerFor(name: string): { markFailed(job: DocumentJob): Promise<void> } | null {
    if (name === SCAN_DOCUMENT_JOB) return this.scan;
    return name === PROCESS_DOCUMENT_JOB ? this.extraction : null;
  }
}

/** An error that is not retried, or the last attempt. */
function isFinalAttempt(job: Job, error: Error): boolean {
  return error.name === 'UnrecoverableError' || job.attemptsMade >= (job.opts.attempts ?? 1);
}
