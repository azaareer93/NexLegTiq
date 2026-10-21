import type { DocumentType } from '@nexlegtiq/shared-types';

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
 * The auto-summary rule (D-132), behind `AI_AUTO_SUMMARY` until the document-summary story enqueues the job: a
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
