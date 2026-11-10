import { AI_FEEDBACK_REASONS, AI_JOB_STATUSES, AI_SOURCE_TYPES } from '@nexlegtiq/shared-types';
import { z } from 'zod';

import { longText } from './fields.js';

/** Answer of AI endpoints that queue work: 202 `{ jobId, status }` (api-conventions.md). */
export const AiJobAcceptedSchema = z.object({
  jobId: z.uuid(),
  status: z.enum(AI_JOB_STATUSES),
});

/** `GET /jobs/:id` (D-130): only to its creator. `result` holds ids of what was produced, never AI text. */
export const AiJobSchema = z.object({
  id: z.uuid(),
  type: z.string(),
  status: z.enum(AI_JOB_STATUSES),
  sourceType: z.enum(AI_SOURCE_TYPES).nullable(),
  sourceId: z.uuid().nullable(),
  /** Error code of a FAILED job (AI-001…005, AUTH-103, SYS-001); the app shows `errors.<code>`. */
  errorCode: z.string().nullable(),
  result: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
});

/**
 * `GET /ai/usage` (D-144): successful, non-cached AI operations of the office this month, counted in its time zone.
 * `quota` and `remaining` are null for an unlimited plan; `resetsAt` is the start of the office's next month.
 */
export const AiUsageSummarySchema = z.object({
  used: z.number().int().nonnegative(),
  quota: z.number().int().nonnegative().nullable(),
  remaining: z.number().int().nonnegative().nullable(),
  resetsAt: z.iso.datetime(),
});
export type AiUsageSummary = z.infer<typeof AiUsageSummarySchema>;

export type AiJobAccepted = z.infer<typeof AiJobAcceptedSchema>;
export type AiJob = z.infer<typeof AiJobSchema>;

const SummaryLanguageSchema = z.enum(['AR', 'EN']);

/** `POST /ai/summaries` (D-148): summarise a document in a language — 202 `{jobId}`, or 200 with a stored summary. */
export const CreateAiSummarySchema = z.object({
  sourceType: z.literal('DOCUMENT'),
  sourceId: z.uuid(),
  language: SummaryLanguageSchema,
  /** Regenerate although a summary of this version, language and prompt is stored (counts against the quota). */
  force: z.boolean().default(false),
});
export type CreateAiSummaryRequest = z.input<typeof CreateAiSummarySchema>;

/**
 * `GET /ai/summaries`: either `?sourceType=DOCUMENT&sourceId` (the latest summary per language of that document's
 * current version) or `?fileId` (the same for every live document of the file the caller may see). Exactly one form.
 */
export const AiSummaryQuerySchema = z
  .object({
    sourceType: z.literal('DOCUMENT').optional(),
    sourceId: z.uuid().optional(),
    fileId: z.uuid().optional(),
  })
  .refine(
    (q) =>
      q.fileId
        ? q.sourceType === undefined && q.sourceId === undefined
        : q.sourceType !== undefined && q.sourceId !== undefined,
    { message: 'validation.summaryQuery', path: ['fileId'] },
  );
export type AiSummaryQuery = z.infer<typeof AiSummaryQuerySchema>;

/** An AI summary (D-148): always shown with its disclaimer (D-057); `dates` keep the document's own wording. */
export const AiSummarySchema = z.object({
  id: z.uuid(),
  sourceType: z.enum(AI_SOURCE_TYPES),
  sourceId: z.uuid(),
  fileId: z.uuid(),
  versionNumber: z.number().int().nullable(),
  language: SummaryLanguageSchema,
  summary: z.string(),
  keyFacts: z.array(z.string()),
  keyLegalIssues: z.array(z.string()),
  parties: z.array(z.string()),
  dates: z.array(z.object({ date: z.string(), event: z.string() })),
  provider: z.string(),
  model: z.string(),
  promptVersion: z.string(),
  /** How many parts a long document was read in (1 = whole). */
  chunks: z.number().int().positive(),
  createdAt: z.iso.datetime(),
});
export type AiSummary = z.infer<typeof AiSummarySchema>;

/** An item of `GET /ai/summaries?fileId`: the summary plus the document it summarises. */
export const AiSummaryListItemSchema = AiSummarySchema.extend({
  source: z.object({
    type: z.literal('DOCUMENT'),
    id: z.uuid(),
    name: z.string(),
    isConfidential: z.boolean(),
  }),
});
export type AiSummaryListItem = z.infer<typeof AiSummaryListItemSchema>;

/** `POST /ai/summaries/:id/feedback` (201 `{id}`): why a summary was not good. The comment is plain text. */
export const AiFeedbackSchema = z.object({
  reason: z.enum(AI_FEEDBACK_REASONS),
  comment: longText(1000).optional(),
});
export type AiFeedbackRequest = z.infer<typeof AiFeedbackSchema>;
export const AiFeedbackCreatedSchema = z.object({ id: z.uuid() });
export type AiFeedbackCreated = z.infer<typeof AiFeedbackCreatedSchema>;
