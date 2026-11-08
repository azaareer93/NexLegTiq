import type { DocumentType } from '@nexlegtiq/shared-types';
import type { PinoLogger } from 'nestjs-pino';

import { AppException } from '../../../common/errors/app.exception';
import type { AiJobs } from '../../ai/ai-jobs';
import { SUMMARIZE_DOCUMENT_JOB } from '../../ai-summaries/summary-job';

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
      select: { uiLanguage: true };
    }): Promise<{ uiLanguage: 'AR' | 'EN' }>;
  };
}

/**
 * Queues the automatic summary (ai-ocr.md OCR pipeline step 6, D-148) for the version's uploader, in their language. AI
 * off, no plan flag or no quota left is not an error here: the summary is skipped and logged, the document stays READY.
 */
export async function enqueueAutoSummary(
  db: UserReader,
  jobs: Pick<AiJobs, 'enqueue'>,
  logger: Pick<PinoLogger, 'info'>,
  { documentId, uploaderId }: { documentId: string; uploaderId: string },
): Promise<void> {
  try {
    const { uiLanguage } = await db.user.findFirstOrThrow({
      where: { id: uploaderId },
      select: { uiLanguage: true },
    });
    await jobs.enqueue({
      type: SUMMARIZE_DOCUMENT_JOB,
      sourceType: 'DOCUMENT',
      sourceId: documentId,
      fields: { documentId, language: uiLanguage },
      createdById: uploaderId,
    });
  } catch (error) {
    const code = error instanceof AppException ? error.code : 'SYS-001';
    logger.info({ documentId, code }, 'Auto-summary skipped');
  }
}
