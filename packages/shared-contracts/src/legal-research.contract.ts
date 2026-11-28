import { JURISDICTIONS } from '@nexlegtiq/shared-types';
import { z } from 'zod';

import { longText } from './fields.js';

/**
 * `POST /ai/research` (D-256): a general legal question — never case data, no file. 202 `{jobId}`, or 200 when the same
 * question was answered within the cache time. `jurisdiction` defaults to the office's.
 */
export const CreateLegalResearchSchema = z.object({
  question: longText(2000).min(1, 'validation.required'),
  language: z.enum(['AR', 'EN']),
  jurisdiction: z.enum(JURISDICTIONS).optional(),
});
export type CreateLegalResearchRequest = z.infer<typeof CreateLegalResearchSchema>;

/** A page the answer is grounded in, as the search found it (never written by the model). */
export const LegalResearchCitationSchema = z.object({
  url: z.url({ protocol: /^https?$/ }),
  title: z.string().max(300),
  date: z.string().max(40).nullable(),
});
export type LegalResearchCitation = z.infer<typeof LegalResearchCitationSchema>;

/**
 * A research answer (D-256), shown with the AI disclaimer (D-057). `unsourced` = no citation was found: the app says so.
 * Never applied to case data; it is read by a lawyer.
 */
export const LegalResearchSchema = z.object({
  answer: z.string(),
  citations: z.array(LegalResearchCitationSchema).max(20),
  jurisdictionNote: z.string().nullable(),
  unsourced: z.boolean(),
  jurisdiction: z.enum(JURISDICTIONS),
  language: z.enum(['AR', 'EN']),
  provider: z.string(),
  model: z.string(),
  promptVersion: z.string(),
  createdAt: z.iso.datetime(),
});
export type LegalResearch = z.infer<typeof LegalResearchSchema>;
