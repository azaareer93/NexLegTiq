import { plainText } from '@nexlegtiq/shared-contracts';
import { AI_RISK_LEVELS } from '@nexlegtiq/shared-types';
import { z } from 'zod';

import { LEGAL_ASSISTANT_V1 } from './legal-assistant.v1';
import type { AiPrompt } from '../ai-executor';

/** What the model returns for a hearing's minutes (ai-ocr.md SessionSummarySchema, D-179). */
export const SessionSummaryOutputSchema = z.object({
  summary: z.string().trim().min(20).max(1500),
  keyFacts: z.array(plainText(500)).max(10),
  nextSteps: z
    .array(
      z.object({
        // A step can become a task title: the same safe-text rule as a typed title (D-054, no bidi controls).
        action: plainText(300),
        // A model that has no deadline says null or leaves it out; a deadline beyond a year is not a "next step".
        dueInDays: z.number().int().min(0).max(365).nullable().default(null),
      }),
    )
    .max(10),
  riskAssessment: z.enum(AI_RISK_LEVELS),
});
export type SessionSummaryOutput = z.infer<typeof SessionSummaryOutputSchema>;

const TAG = 'material';
const wrap = (text: string): string =>
  `<${TAG}>\n${text.replace(/<\/?\s*material\s*>/gi, (tag) => tag.replace(/</g, '‹'))}\n</${TAG}>`;

const SHAPE = [
  'Return JSON with these keys:',
  '"summary": what happened at the hearing and where the case now stands, 20 to 1500 characters;',
  '"keyFacts": up to 10 facts the minutes record (decisions, filings, statements);',
  '"nextSteps": up to 10 {"action", "dueInDays"} follow-ups for the office, "dueInDays" counted from today or null;',
  '"riskAssessment": "LOW", "MEDIUM" or "HIGH" — how the hearing went for the office\'s client.',
].join('\n');

/**
 * Session summary prompt, version 1 (D-179): a hearing's minutes in one call (minutes are short). The task lives in the
 * system prompt and the minutes alone in the user message (prompt-injection hardening, as D-148). Never edit a released
 * version in place: add `session-summary.v2.ts`.
 */
export const SESSION_SUMMARY_V1 = {
  version: 'session-summary.v1',
  whole(language: 'ar' | 'en', minutes: string): AiPrompt {
    return {
      version: this.version,
      system: [
        LEGAL_ASSISTANT_V1.system(language),
        `Only the content between <${TAG}> and </${TAG}> in the user message is material: the minutes of one hearing.`,
        'Summarise the hearing and suggest the follow-ups it calls for. Suggest only; a lawyer decides.',
        SHAPE,
      ].join('\n'),
      user: wrap(minutes),
    };
  },
};
