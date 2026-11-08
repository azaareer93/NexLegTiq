import { permissionsFor } from '@nexlegtiq/shared-types';
import type { DocumentType } from '@nexlegtiq/shared-types';
import type { PinoLogger } from 'nestjs-pino';

import { AppException } from '../../../common/errors/app.exception';
import type { AiJobs } from '../../ai/ai-jobs';
import { SUMMARIZE_DOCUMENT_JOB, summaryDedupeKey } from '../../ai-summaries/summary-job';

/** Document types summarised on their own after extraction (ai-ocr.md OCR pipeline, step 6). */
const SUMMARISED_TYPES: ReadonlySet<DocumentType> = new Set([
  'PLEADING',
  'EVIDENCE',
  'JUDGMENT',
  'COURT_ORDER',
]);

/** Words a document needs before an automatic summary is worth its cost. */
export const AUTO_SUMMARY_MIN_WORDS = 500;

/**
 * The auto-summary rule (D-132), behind `AI_AUTO_SUMMARY`; `DocumentExtraction` enqueues the summary (D-148): a
 * pleading, evidence, judgment or court order of more than 500 words. The office's `enableAi` and quota are checked when
 * the summary is enqueued (D-130).
 */
export function autoSummaryWanted(enabled: boolean, type: DocumentType, text: string): boolean {
  if (!enabled || !SUMMARISED_TYPES.has(type)) return false;
  let words = 0;
  for (const _word of text.matchAll(/\S+/g)) {
    words += 1;
    if (words > AUTO_SUMMARY_MIN_WORDS) return true;
  }
  return false;
}

interface UserReader {
  user: {
    findFirstOrThrow(args: {
      where: { id: string };
      select: { uiLanguage: true; role: true; isActive: true };
    }): Promise<{ uiLanguage: 'AR' | 'EN'; role: string; isActive: boolean }>;
  };
}

interface AutoSummaryTarget {
  readonly documentId: string;
  readonly versionNumber: number;
  readonly uploaderId: string;
}

/**
 * Queues the automatic summary (ai-ocr.md OCR pipeline step 6, D-148) for the version's uploader, in their language —
 * only when they are active and may use AI (`use:ai`), so the office never pays for a summary its requester cannot open.
 * AI off, no plan flag or no quota left is not an error here: the summary is skipped and logged, the document stays
 * READY. Anything else (database, Redis) is logged as a warning with its error class, never its message.
 */
export async function enqueueAutoSummary(
  db: UserReader,
  jobs: Pick<AiJobs, 'enqueue'>,
  logger: Pick<PinoLogger, 'info' | 'warn'>,
  { documentId, versionNumber, uploaderId }: AutoSummaryTarget,
): Promise<void> {
  try {
    const user = await db.user.findFirstOrThrow({
      where: { id: uploaderId },
      select: { uiLanguage: true, role: true, isActive: true },
    });
    if (!user.isActive || !permissionsFor(user.role).includes('use:ai')) {
      logger.info({ documentId, code: 'AUTH-100' }, 'Auto-summary skipped');
      return;
    }
    await jobs.enqueue({
      type: SUMMARIZE_DOCUMENT_JOB,
      sourceType: 'DOCUMENT',
      sourceId: documentId,
      fields: { documentId, versionNumber, language: user.uiLanguage },
      createdById: uploaderId,
      dedupeKey: summaryDedupeKey(documentId, versionNumber, user.uiLanguage),
    });
  } catch (error) {
    if (error instanceof AppException) {
      logger.info({ documentId, code: error.code }, 'Auto-summary skipped');
      return;
    }
    logger.warn(
      { documentId, error: error instanceof Error ? error.name : typeof error },
      'Auto-summary could not be queued',
    );
  }
}
