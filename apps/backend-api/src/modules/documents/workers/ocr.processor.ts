import { OnWorkerEvent, Processor } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import type { Job } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';

import { QUEUE, workerOptions } from '../../../common/queue/queues';
import { parseTenantJob } from '../../../common/queue/tenant-job';
import type { TenantJobData } from '../../../common/queue/tenant-job';
import { TenantProcessor } from '../../../common/queue/tenant-processor';
import { TenantRunner } from '../../../common/tenancy/tenant-runner';
import { PrismaService } from '../../../database/prisma.service';
import { DocumentJobSchema, PROCESS_DOCUMENT_JOB, SCAN_DOCUMENT_JOB } from '../document-jobs';
import type { DocumentJob } from '../document-jobs';
import { DocumentScan } from '../document-scan';

/**
 * The single consumer of the `ocr` queue (D-126):
 * - `scan-document`: the ClamAV scan of an uploaded version (`DocumentScan`); after the last failed attempt the
 *   document is FAILED;
 * - `process-document`: text extraction — not built yet (its own story); the job completes as skipped and the document
 *   stays PROCESSING until that story picks such documents up again.
 */
@Injectable()
@Processor(QUEUE.OCR, workerOptions(QUEUE.OCR))
export class OcrProcessor extends TenantProcessor<DocumentJob> {
  protected readonly schema = DocumentJobSchema;

  constructor(
    tenant: TenantRunner,
    prisma: PrismaService,
    logger: PinoLogger,
    private readonly scan: DocumentScan,
  ) {
    super(tenant, prisma, logger);
  }

  protected async handle(
    job: Job<DocumentJob & TenantJobData>,
    signal: AbortSignal,
  ): Promise<unknown> {
    const { documentId, versionNumber } = job.data;
    if (job.name === SCAN_DOCUMENT_JOB) {
      return { outcome: await this.scan.run({ documentId, versionNumber }, signal) };
    }
    if (job.name === PROCESS_DOCUMENT_JOB) return { skipped: 'TEXT_EXTRACTION_NOT_BUILT' };
    throw new UnrecoverableError(`Unknown ocr job ${job.name}`);
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job | undefined, error: Error): Promise<void> {
    if (job?.name !== SCAN_DOCUMENT_JOB) return;
    const final =
      error.name === 'UnrecoverableError' || job.attemptsMade >= (job.opts.attempts ?? 1);
    const tenant = parseTenantJob(job.data);
    const fields = DocumentJobSchema.safeParse(job.data);
    if (!final || !tenant || !fields.success) return;
    try {
      await this.tenant.run({ officeId: tenant.officeId }, () => this.scan.markFailed(fields.data));
    } catch (markError) {
      this.logger.error(
        { err: markError, documentId: fields.data.documentId },
        'Document not marked FAILED',
      );
    }
  }
}
