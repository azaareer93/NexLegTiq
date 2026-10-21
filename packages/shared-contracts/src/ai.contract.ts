import { AI_JOB_STATUSES, AI_SOURCE_TYPES } from '@nexlegtiq/shared-types';
import { z } from 'zod';

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

export type AiJobAccepted = z.infer<typeof AiJobAcceptedSchema>;
export type AiJob = z.infer<typeof AiJobSchema>;
