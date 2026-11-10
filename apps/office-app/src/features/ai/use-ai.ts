import { aiApi } from '@nexlegtiq/shared-api-client';
import type { AiFeedbackRequest, AiJob, CreateAiSummaryRequest } from '@nexlegtiq/shared-contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiClient } from '../auth';

const ai = aiApi(apiClient);

/** Under `ai`: the realtime bridge refreshes the whole prefix on `ai.job.*` and `document.summary.ready` (D-129). */
export const aiKeys = {
  all: ['ai'] as const,
  usage: ['ai', 'usage'] as const,
  summariesAll: ['ai', 'summaries'] as const,
  summaries: (fileId: string) => ['ai', 'summaries', fileId] as const,
  job: (jobId: string) => ['ai', 'job', jobId] as const,
};

/** Milliseconds between job checks while the socket is silent (the fallback to `ai.job.*` events). */
export const JOB_POLL_MS = 5_000;
export const isFinished = (job: AiJob | undefined): boolean =>
  job?.status === 'SUCCEEDED' || job?.status === 'FAILED';

export const useAiUsage = () =>
  useQuery({ queryKey: aiKeys.usage, queryFn: ({ signal }) => ai.usage(signal), retry: false });

export const useFileSummaries = (fileId: string) =>
  useQuery({
    queryKey: aiKeys.summaries(fileId),
    queryFn: ({ signal }) => ai.byFile(fileId, signal),
    retry: false,
  });

export const useAiJob = (jobId: string) =>
  useQuery({
    queryKey: aiKeys.job(jobId),
    queryFn: ({ signal }) => ai.job(jobId, signal),
    refetchInterval: (query) => (isFinished(query.state.data) ? false : JOB_POLL_MS),
    gcTime: 0,
  });

/** A stored summary (200) refreshes the list at once; a queued job (202) is followed by the caller. */
export function useRequestSummary(fileId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateAiSummaryRequest) => ai.request(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: aiKeys.summaries(fileId) });
      void queryClient.invalidateQueries({ queryKey: aiKeys.usage });
    },
  });
}

export const useSummaryFeedback = () =>
  useMutation({
    mutationFn: ({ id, body }: { id: string; body: AiFeedbackRequest }) => ai.feedback(id, body),
  });
