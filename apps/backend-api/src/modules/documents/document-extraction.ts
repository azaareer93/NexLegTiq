import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { documentJobId } from './document-jobs';
import type { DocumentJob } from './document-jobs';
import { autoSummaryWanted } from './extraction/auto-summary';
import { extractable, extractText } from './extraction/extract-text';
import { ocr, ocrable } from './extraction/ocr';
import type { OcrResult } from './extraction/ocr';
import { visionWithin, weakRead } from './extraction/vision';
import { QueueProducer } from '../../common/queue/queue-producer';
import { QUEUE } from '../../common/queue/queues';
import { RealtimePublisher } from '../../common/realtime/realtime.publisher';
import { StorageService } from '../../common/storage/storage.service';
import { AppConfig } from '../../config/app-config';
import { PrismaService } from '../../database/prisma.service';
import { UnitOfWork } from '../../database/unit-of-work';
import { Prisma } from '../../generated/prisma/client';
import type { DocumentType } from '../../generated/prisma/client';
import { CREATE_NOTIFICATION_JOB } from '../notifications/notification-job';
import type { NotificationJob } from '../notifications/notification-job';
import { EntitlementsService } from '../subscriptions/entitlements.service';

/** READY with text, NO_TEXT = READY without (legacy .doc, OCR off), SUPERSEDED = replaced or deleted meanwhile. */
export type ExtractionOutcome = 'READY' | 'NO_TEXT' | 'SUPERSEDED';

interface ProcessedVersion {
  readonly createdById: string;
  readonly document: {
    readonly officeId: string;
    readonly fileId: string;
    readonly documentType: DocumentType;
  };
}

interface VersionText {
  readonly text: string;
  readonly pageCount: number | null;
  readonly ocrEngine: string;
  readonly ocrConfidence?: number | null;
  readonly pageConfidences?: (number | null)[];
  readonly ocrCostUsd?: string;
}

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
 * Text of a clean version, run by the `ocr` worker in the document's office after its scan: DOCX, XLSX, CSV and PDFs with
 * a text layer are read (D-132), scanned PDFs and images (JPEG, PNG, TIFF) go through Tesseract unless the office switched
 * OCR off (D-139). Text gives a `DocumentText` row (search vectors by trigger, D-119) and READY with `ocrStatus` DONE; a
 * legacy .doc, or OCR off, gives READY without text (`ocrStatus` NOT_NEEDED). The person who uploaded the version is told
 * — `document.processed` (ids only) when it is ready or failed, and an in-app notification when it failed. A version
 * replaced or a document deleted meanwhile changes nothing.
 */
const tesseractText = (result: OcrResult): VersionText => ({
  text: result.text,
  pageCount: result.pageCount,
  ocrEngine: 'tesseract',
  ocrConfidence: result.confidence,
  pageConfidences: [...result.pageConfidences],
});

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
    private readonly entitlements: EntitlementsService,
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
    const { mimeType } = version;
    if (!(await this.worthReading(job, mimeType))) return this.finish(job, version, null);
    const content = await readAll(await this.storage.getStream(version.storageKey), signal);
    signal.throwIfAborted();
    const extraction = extractable(mimeType)
      ? await extractText(content, mimeType)
      : ({ kind: 'NEEDS_OCR' } as const);
    signal.throwIfAborted();
    if (extraction.kind === 'TEXT') {
      // A text layer is read whatever the office's OCR switch says: no OCR is involved.
      const { text, pageCount, engine } = extraction;
      return this.finish(job, version, { text, pageCount, ocrEngine: engine });
    }
    // An image's switch was read before downloading it; a scanned PDF's only now.
    if (extractable(mimeType) && !(await this.ocrEnabled(job))) {
      return this.finish(job, version, null);
    }
    return this.finish(
      job,
      version,
      await this.recognise(job, content, mimeType, extraction.pageCount, signal),
    );
  }

  /** A legacy .doc (no reader, nothing to OCR) is not; an image only when the office's OCR is on (D-139). */
  private async worthReading(job: DocumentJob, mimeType: string): Promise<boolean> {
    if (extractable(mimeType)) return true;
    return ocrable(mimeType) && (await this.ocrEnabled(job));
  }

  /** Tesseract OCR of a scan or an image (D-139); a scan longer than OCR_MAX_PAGES is read up to the cap. */
  private async recognise(
    job: DocumentJob,
    content: Buffer,
    mimeType: string,
    pdfPageCount: number | undefined,
    signal: AbortSignal,
  ): Promise<VersionText> {
    const { maxPages } = this.config.ocr;
    if (pdfPageCount !== undefined && pdfPageCount > maxPages) {
      this.logger.info(
        { documentId: job.documentId, pages: pdfPageCount, read: maxPages },
        'Scan longer than OCR_MAX_PAGES: only its first pages are read',
      );
    }
    const result = await ocr(content, mimeType, {
      maxPages,
      ...(pdfPageCount !== undefined ? { pdfPageCount } : {}),
      signal,
    });
    signal.throwIfAborted();
    return (
      (await this.visionFallback(job, content, mimeType, result, signal)) ?? tesseractText(result)
    );
  }

  /**
   * Google Vision re-reads a scan Tesseract read poorly (D-142): mean confidence under OCR_VISION_MIN_CONFIDENCE, or no
   * word at all on a scan with pages — only when `visionAllowed`. Vision's text is kept when it reads better than
   * Tesseract's; either way the pages were paid for, so the cost is stored (and counts against the page budget).
   */
  private async visionFallback(
    job: DocumentJob,
    content: Buffer,
    mimeType: string,
    tesseract: OcrResult,
    signal: AbortSignal,
  ): Promise<VersionText | null> {
    const config = this.config.vision;
    if (!config || !weakRead(tesseract, config.minConfidence)) return null;
    if (!(await this.visionAllowed(job, tesseract.pageCount))) return null;
    const vision = await visionWithin(content, mimeType, {
      pages: tesseract.pageCount,
      signal,
      config,
    });
    if (!vision) return null;
    if ('failed' in vision) {
      this.logger.warn(
        { documentId: job.documentId, code: vision.failed },
        'Google Vision failed; Tesseract result kept',
      );
      return null;
    }
    this.logger.info(
      { documentId: job.documentId, pages: vision.pageCount, costUsd: vision.costUsd },
      'Scan re-read by Google Vision',
    );
    const better =
      vision.text.length > 0 && (vision.confidence ?? 0) > (tesseract.confidence ?? -1);
    if (!better) return { ...tesseractText(tesseract), ocrCostUsd: vision.costUsd };
    return {
      text: vision.text,
      pageCount: vision.pageCount,
      ocrEngine: 'google-vision',
      ocrConfidence: vision.confidence,
      pageConfidences: [...vision.pageConfidences],
      ocrCostUsd: vision.costUsd,
    };
  }

  /** Plan flag (not read-only), office opt-in, a non-confidential document, pages left this month. */
  private async visionAllowed(job: DocumentJob, pages: number): Promise<boolean> {
    const entitlements = await this.entitlements.current();
    if (entitlements.readOnly || !entitlements.features.googleVisionOcr) return false;
    const [settings, document] = await Promise.all([
      this.prisma.db.officeSettings.findFirst({ select: { enableVisionOcr: true } }),
      this.prisma.db.document.findFirst({
        where: { id: job.documentId },
        select: { isConfidential: true },
      }),
    ]);
    if (!settings?.enableVisionOcr || document?.isConfidential !== false) return false;
    return (await this.entitlements.visionPagesLeft()) >= pages;
  }

  /** The office's switch (D-125); a missing settings row keeps the column default (on). */
  private async ocrEnabled(job: DocumentJob): Promise<boolean> {
    const settings = await this.prisma.db.officeSettings.findFirst({ select: { enableOcr: true } });
    const enabled = settings?.enableOcr ?? true;
    if (!enabled) this.logger.info({ documentId: job.documentId }, 'OCR is off for the office');
    return enabled;
  }

  /**
   * READY with the version's text (`ocrStatus` DONE), or without text (`ocrStatus` NOT_NEEDED: a legacy .doc, or OCR
   * switched off by the office). Guarded on "still PROCESSING and still this version", so a replaced version or a second
   * run changes nothing.
   */
  private async finish(
    job: DocumentJob,
    version: ProcessedVersion,
    text: VersionText | null,
  ): Promise<ExtractionOutcome> {
    const { document } = version;
    const ready = await this.uow.run(async (tx, afterCommit) => {
      const { count } = await tx.document.updateMany({
        where: processing(job),
        data: {
          status: 'READY',
          ocrStatus: text ? 'DONE' : 'NOT_NEEDED',
          processingErrorCode: null,
        },
      });
      if (count === 0) return false;
      afterCommit(
        async () => this.told(version.createdById, job.documentId, document.fileId),
        'realtime document.processed',
      );
      if (!text) return true;
      const data = {
        text: text.text,
        pageCount: text.pageCount,
        ocrEngine: text.ocrEngine,
        ocrConfidence: text.ocrConfidence ?? null,
        ocrCostUsd: text.ocrCostUsd ?? null,
        pageConfidences: text.pageConfidences ?? Prisma.DbNull,
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
      return true;
    });
    if (!ready) return 'SUPERSEDED';
    if (!text) return 'NO_TEXT';
    if (autoSummaryWanted(this.config.ocr.autoSummary, document.documentType, text.text)) {
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
