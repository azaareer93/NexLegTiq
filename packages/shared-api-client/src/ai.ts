import {
  AiFeedbackCreatedSchema,
  AiJobAcceptedSchema,
  AiJobSchema,
  AiSummaryListItemSchema,
  AiSummarySchema,
  AiUsageSummarySchema,
  TaskSchema,
} from '@nexlegtiq/shared-contracts';
import type {
  AiFeedbackCreated,
  AiFeedbackRequest,
  AiJob,
  AiJobAccepted,
  AiSummary,
  AiSummaryListItem,
  AiUsageSummary,
  CreateAiSummaryRequest,
  CreateTasksFromSummaryRequest,
  Task,
} from '@nexlegtiq/shared-contracts';
import { z } from 'zod';

import type { ApiClient } from './api-client.js';

/** The two answers of `POST /ai/summaries` (D-148): a stored summary (200) or a queued job (202), told apart by `jobId`. */
const RequestAnswerSchema = z.union([AiJobAcceptedSchema, AiSummarySchema]);

/** AI summaries, jobs and usage (D-130, D-144, D-148). */
export function aiApi(client: ApiClient) {
  return {
    /** The file's summaries, newest version of each document and language, with the document they belong to. */
    byFile: (fileId: string, signal?: AbortSignal): Promise<AiSummaryListItem[]> =>
      client.request(
        { method: 'GET', path: 'ai/summaries', query: { fileId }, signal },
        AiSummaryListItemSchema.array(),
      ),
    byDocument: (documentId: string, signal?: AbortSignal): Promise<AiSummary[]> =>
      client.request(
        {
          method: 'GET',
          path: 'ai/summaries',
          query: { sourceType: 'DOCUMENT', sourceId: documentId },
          signal,
        },
        AiSummarySchema.array(),
      ),
    /** The current summaries of a session's minutes, one per language (D-179). */
    bySession: (sessionId: string, signal?: AbortSignal): Promise<AiSummary[]> =>
      client.request(
        {
          method: 'GET',
          path: 'ai/summaries',
          query: { sourceType: 'SESSION', sourceId: sessionId },
          signal,
        },
        AiSummarySchema.array(),
      ),
    /** Tasks from the next steps the user picked (D-179): all or none. */
    createTasks: (summaryId: string, body: CreateTasksFromSummaryRequest): Promise<Task[]> =>
      client.request(
        {
          method: 'POST',
          path: `ai/summaries/${encodeURIComponent(summaryId)}/create-tasks`,
          body,
        },
        TaskSchema.array(),
      ),
    /** A stored summary comes back as is; otherwise a job to follow (`GET /jobs/:id`, `ai.job.*`). `force` regenerates. */
    request: (body: CreateAiSummaryRequest): Promise<AiSummary | AiJobAccepted> =>
      client.request({ method: 'POST', path: 'ai/summaries', body }, RequestAnswerSchema),
    feedback: (summaryId: string, body: AiFeedbackRequest): Promise<AiFeedbackCreated> =>
      client.request(
        { method: 'POST', path: `ai/summaries/${encodeURIComponent(summaryId)}/feedback`, body },
        AiFeedbackCreatedSchema,
      ),
    job: (jobId: string, signal?: AbortSignal): Promise<AiJob> =>
      client.request(
        { method: 'GET', path: `jobs/${encodeURIComponent(jobId)}`, signal },
        AiJobSchema,
      ),
    usage: (signal?: AbortSignal): Promise<AiUsageSummary> =>
      client.request({ method: 'GET', path: 'ai/usage', signal }, AiUsageSummarySchema),
  };
}
