import { aiApi } from '@nexlegtiq/shared-api-client';
import type { CreateLegalResearchRequest } from '@nexlegtiq/shared-contracts';
import { useMutation, useQuery } from '@tanstack/react-query';

import { apiClient } from '../auth';

const ai = aiApi(apiClient);

/** Under `ai`: the realtime bridge refreshes the prefix on `ai.job.*` (D-129). */
export const researchKeys = {
  result: (jobId: string) => ['ai', 'research', jobId] as const,
};

export const useAskResearch = () =>
  useMutation({ mutationFn: (body: CreateLegalResearchRequest) => ai.research(body) });

/** The answer of a finished job (it is kept 24 h on the server). */
export const useResearchResult = (jobId: string | undefined, ready: boolean) =>
  useQuery({
    queryKey: researchKeys.result(jobId ?? ''),
    queryFn: ({ signal }) => ai.researchResult(jobId ?? '', signal),
    enabled: Boolean(jobId) && ready,
    retry: false,
  });
