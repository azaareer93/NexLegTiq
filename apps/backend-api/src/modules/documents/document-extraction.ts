import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { documentJobId } from './document-jobs';
import type { DocumentJob } from './document-jobs';
import { autoSummaryWanted } from './extraction/auto-summary';
import { extractable, extractText } from './extraction/extract-text';
import { QueueProducer } from '../../common/queue/queue-producer';
import { QUEUE } from '../../common/queue/queues';
import { RealtimePublisher } from '../../common/realtime/realtime.publisher';
import { StorageService } from '../../common/storage/storage.service';
import { AppConfig } from '../../config/app-config';
import { PrismaService } from '../../database/prisma.service';
import { UnitOfWork } from '../../database/unit-of-work';
import { CREATE_NOTIFICATION_JOB } from '../notifications/notification-job';
import type { NotificationJob } from '../notifications/notification-job';

export type ExtractionOutcome = 'READY' | 'NEEDS_OCR' | 'SUPERSEDED';

/** Why processing failed: EXT-002 (could not finish — a retry may succeed) or VAL-005 (unreadable — it will not). */
export type ProcessingFailure = 'EXT-002' | 'VAL-005';

/** Only a live document that still mirrors this version, while it is being processed, changes. */
const processing = (job: DocumentJob) => ({
  id: job.documentId,
  currentVersion: job.versionNumber,
  status: 'PROCESSING' as const,
  deletedAt: null,
});

/** A stored version is at most 50 MB (D-035); reading it whole is fine for the extractors, which need the bytes. */
async function readAll(stream: NodeJS.ReadableStream, signal: AbortSignal): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    signal.throwIfAborted();
    chunks.push(Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

/**
 * Text extraction of a clean version (D-132), run by the `ocr` worker in the document's office after its scan:
 * DOCX, XLSX, CSV and PDFs with a text layer give a `DocumentText` row (search vectors by trigger, D-119) and the document
 * becomes READY (`ocrStatus` DONE); scans, images and legacy .doc wait for the OCR path (still PROCESSING, `ocrStatus`
 * PENDING) without being downloaded. The person who uploaded the version is told — `document.processed` (ids only) when
 * it is ready or failed, and an in-app notification when it failed. A version replaced or a document deleted meanwhile
 * changes nothing.
 */
@Injectable()
export class DocumentExtraction {
  constructor(
    private readonly prisma: PrismaService,
    private readonly uow: UnitOfWork,
    private readonly storage: StorageService,
    private readonly realtime: RealtimePublisher,
    private readonly queues: QueueProducer,
    private readonly config: AppConfig,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(DocumentExtraction.name);
  }

  async run(
    job: DocumentJob,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<ExtractionOutcome> {
    const version = await this.prisma.db.documentVersion.findFirst({
      where: {
        documentId: job.documentId,
        versionNumber: job.versionNumber,
        document: processing(job),
      },
      select: {
        storageKey: true,
        mimeType: true,
        createdById: true,
        document: { select: { officeId: true, fileId: true, documentType: true } },
      },
    });
    if (!version) return 'SUPERSEDED';
    if (!extractable(version.mimeType)) {
      // The OCR path picks such documents up (PROCESSING, ocrStatus PENDING).
      this.logger.info(
        { documentId: job.documentId, mimeType: version.mimeType },
        'Document needs OCR',
      );
      return 'NEEDS_OCR';
    }
    const content = await readAll(await this.storage.getStream(version.storageKey), signal);
    signal.throwIfAborted();
    const extraction = await extractText(content, version.mimeType);
    if (extraction.kind === 'NEEDS_OCR') {
      this.logger.info({ documentId: job.documentId }, 'PDF without a text layer needs OCR');
      return 'NEEDS_OCR';
    }
    signal.throwIfAborted();
    const { document } = version;
    const ready = await this.uow.run(async (tx, afterCommit) => {
      const { count } = await tx.document.updateMany({
        where: processing(job),
        data: { status: 'READY', ocrStatus: 'DONE', processingErrorCode: null },
      });
      if (count === 0) return false;
      const data = {
        text: extraction.text,
        pageCount: extraction.pageCount,
        ocrEngine: extraction.engine,
        ocrConfidence: null,
        extractedAt: new Date(),
      };
      await tx.documentText.upsert({
        where: {
          documentId_versionNumber: {
            documentId: job.documentId,
            versionNumber: job.versionNumber,
          },
        },
        create: {
          ...data,
          officeId: document.officeId,
          documentId: job.documentId,
          versionNumber: job.versionNumber,
        },
        update: data,
      });
      afterCommit(
        async () => this.told(version.createdById, job.documentId, document.fileId),
        'realtime document.processed',
      );
      return true;
    });
    if (!ready) return 'SUPERSEDED';
    if (autoSummaryWanted(this.config.ocr.autoSummary, document.documentType, extraction.text)) {
      // The document-summary story enqueues the summary here (ai-ocr.md OCR pipeline, step 6).
      this.logger.info({ documentId: job.documentId }, 'Auto-summary wanted');
    }
    return 'READY';
  }

  /**
   * After the last failed attempt: FAILED with its code — EXT-002 can be retried (`POST …/ocr/retry`), VAL-005 (the file
   * cannot be read) cannot. The uploader of the version is told live and by an in-app notification.
   */
  async markFailed(job: DocumentJob, code: ProcessingFailure = 'EXT-002'): Promise<void> {
    const version = await this.prisma.db.documentVersion.findFirst({
      where: {
        documentId: job.documentId,
        versionNumber: job.versionNumber,
        document: processing(job),
      },
      select: { createdById: true, document: { select: { name: true, fileId: true } } },
    });
    if (!version) return;
    const { count } = await this.prisma.db.document.updateMany({
      where: processing(job),
      data: { status: 'FAILED', processingErrorCode: code },
    });
    if (count === 0) return;
    this.told(version.createdById, job.documentId, version.document.fileId);
    await this.queues.enqueue<NotificationJob>(
      QUEUE.NOTIFICATION,
      CREATE_NOTIFICATION_JOB,
      {
        userId: version.createdById,
        type: 'DOCUMENT_FAILED',
        titleKey: 'shell.notifications.documentFailed',
        params: { documentId: job.documentId, name: version.document.name.slice(0, 500), code },
        link: `/cases/${version.document.fileId}?tab=documents`,
      },
      // One notification per failure: a retried document that fails again is reported again.
      { jobId: `${documentJobId('process', job)}-failed-${Date.now()}` },
    );
  }

  private told(userId: string, documentId: string, fileId: string): void {
    this.realtime.toUser(userId, 'document.processed', { documentId, fileId });
  }
}
