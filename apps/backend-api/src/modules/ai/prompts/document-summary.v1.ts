import { z } from 'zod';

import { LEGAL_ASSISTANT_V1 } from './legal-assistant.v1';
import type { AiPrompt } from '../ai-executor';

const item = (max: number) => z.string().trim().min(1).max(max);

/** The summary the model returns (ai-ocr.md DocumentSummarySchema); the stored row and the API carry the same fields. */
export const DocumentSummaryOutputSchema = z.object({
  summary: z.string().trim().min(50).max(1500),
  keyFacts: z.array(item(500)).max(10),
  keyLegalIssues: z.array(item(500)).max(5),
  parties: z.array(item(200)).max(20).default([]),
  dates: z
    .array(z.object({ date: item(60), event: item(300) }))
    .max(20)
    .default([]),
});
export type DocumentSummaryOutput = z.infer<typeof DocumentSummaryOutputSchema>;

/** One part of a long document (the map step): looser, its notes feed the final summary. */
export const PartNotesSchema = z.object({
  summary: z.string().trim().min(1).max(3000),
  keyFacts: z.array(item(500)).max(15),
  keyLegalIssues: z.array(item(500)).max(10),
  parties: z.array(item(200)).max(30).default([]),
  dates: z
    .array(z.object({ date: item(60), event: item(300) }))
    .max(30)
    .default([]),
});
export type PartNotes = z.infer<typeof PartNotesSchema>;

type Language = 'ar' | 'en';

const SHAPE = [
  'Return JSON with these keys:',
  '"summary": what the document is and what it says, 50 to 1500 characters;',
  '"keyFacts": up to 10 facts the document states;',
  '"keyLegalIssues": up to 5 legal questions it raises or decides;',
  '"parties": the people and bodies it names, with their role when stated;',
  '"dates": up to 20 {"date", "event"} pairs, the date written as in the document.',
].join('\n');

const system = (language: Language) => LEGAL_ASSISTANT_V1.system(language);

/**
 * Document summary prompts, version 1 (D-148). A document that fits one call is summarised directly; a long one is read
 * in parts (`part`), whose notes are then merged (`merge`). Never edit in place: add `document-summary.v2.ts`.
 */
export const DOCUMENT_SUMMARY_V1 = {
  version: 'document-summary.v1',
  whole(language: Language, text: string): AiPrompt {
    return {
      version: this.version,
      system: system(language),
      user: `${SHAPE}\n\nDocument:\n${text}`,
    };
  },
  part(language: Language, text: string, index: number, count: number): AiPrompt {
    return {
      version: this.version,
      system: system(language),
      user: [
        `This is part ${index + 1} of ${count} of one document. Take notes on this part only; they are merged later.`,
        SHAPE.replace('50 to 1500', 'up to 3000'),
        '',
        `Part ${index + 1}:`,
        text,
      ].join('\n'),
    };
  },
  merge(language: Language, notes: readonly PartNotes[]): AiPrompt {
    return {
      version: this.version,
      system: system(language),
      user: [
        `These are notes on the ${notes.length} parts of one document, in order. Merge them into one summary of the`,
        'whole document: keep what matters most, drop repetitions, keep every date and party that matters.',
        SHAPE,
        '',
        `Notes:\n${JSON.stringify(notes)}`,
      ].join('\n'),
    };
  },
};
