import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import type { DocumentJob } from './document-jobs';
import { autoSummaryWanted } from './extraction/auto-summary';
import { extractText } from './extraction/extract-text';
import { RealtimePublisher } from '../../common/realtime/realtime.publisher';
import { StorageService } from '../../common/storage/storage.service';
import { AppConfig } from '../../config/app-config';
import { PrismaService } from '../../database/prisma.service';
import { UnitOfWork } from '../../database/unit-of-work';

export type ExtractionOutcome = 'READY' | 'NEEDS_OCR' | 'SUPERSEDED';

/** Only the version a document still mirrors, while it is being processed, changes the document. */
const processing = (job: DocumentJob) => ({
  id: job.documentId,
  currentVersion: job.versionNumber,
  status: 'PROCESSING' as const,
});

/** A stored version is at most 50 MB (D-035); reading it whole is fine for the extractors, which need the bytes. */
async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

/**
 * Text extraction of a clean version (D-132), run by the `ocr` worker in the document's office after its scan:
 * DOCX, XLSX, CSV and PDFs with a text layer give a `DocumentText` row (search vectors by trigger, D-119) and the document
 * becomes READY (`ocrStatus` DONE); scans, images and legacy .doc wait for the OCR path (still PROCESSING, `ocrStatus`
 * PENDING). The uploader's app is told when the document is ready or failed (`document.processed`, ids only). A version
 * replaced meanwhile changes nothing.
 */
@Injectable()
export class DocumentExtraction {
  constructor(
    private readonly prisma: PrismaService,
    private readonly uow: UnitOfWork,
    private readonly storage: StorageService,
    private readonly realtime: RealtimePublisher,
    private readonly config: AppConfig,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(DocumentExtraction.name);
  }

  async run(job: DocumentJob): Promise<ExtractionOutcome> {
    const version = await this.prisma.db.documentVersion.findFirst({
      where: { documentId: job.documentId, versionNumber: job.versionNumber },
      select: {
        storageKey: true,
        mimeType: true,
        document: {
          select: {
            status: true,
            currentVersion: true,
            fileId: true,
            uploadedById: true,
            documentType: true,
          },
        },
      },
    });
    const document = version?.document;
    if (
      !version ||
      !document ||
      document.status !== 'PROCESSING' ||
      document.currentVersion !== job.versionNumber
    ) {
      return 'SUPERSEDED';
    }
    const extraction = await extractText(
      await readAll(await this.storage.getStream(version.storageKey)),
      version.mimeType,
    );
    if (extraction.kind === 'NEEDS_OCR') {
      // The OCR path picks such documents up (PROCESSING, ocrStatus PENDING).
      this.logger.info(
        { documentId: job.documentId, mimeType: version.mimeType },
        'Document needs OCR',
      );
      return 'NEEDS_OCR';
    }
    const ready = await this.uow.run(async (tx, afterCommit) => {
      const { count } = await tx.document.updateMany({
        where: processing(job),
        data: { status: 'READY', ocrStatus: 'DONE', processingErrorCode: null },
      });
      if (count === 0) return false;
      const officeId = (
        await tx.document.findFirstOrThrow({
          where: { id: job.documentId },
          select: { officeId: true },
        })
      ).officeId;
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
        create: { ...data, officeId, documentId: job.documentId, versionNumber: job.versionNumber },
        update: data,
      });
      afterCommit(
        async () => this.told(document.uploadedById, job.documentId, document.fileId),
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

  /** After the last failed attempt: FAILED with EXT-002, so the app can offer "retry" (`POST …/ocr/retry`). */
  async markFailed(job: DocumentJob): Promise<void> {
    const document = await this.prisma.db.document.findFirst({
      where: processing(job),
      select: { uploadedById: true, fileId: true },
    });
    const { count } = await this.prisma.db.document.updateMany({
      where: processing(job),
      data: { status: 'FAILED', processingErrorCode: 'EXT-002' },
    });
    if (count > 0 && document) this.told(document.uploadedById, job.documentId, document.fileId);
  }

  private told(userId: string, documentId: string, fileId: string): void {
    this.realtime.toUser(userId, 'document.processed', { documentId, fileId });
  }
}
