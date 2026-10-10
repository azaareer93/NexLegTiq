import { casesApi } from '@nexlegtiq/shared-api-client';
import type { CaseListParams } from '@nexlegtiq/shared-api-client';
import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { apiClient } from '../../auth';

const cases = casesApi(apiClient);

export const caseKeys = {
  all: ['cases'] as const,
  list: (query: CaseListParams) => [...caseKeys.all, 'list', query] as const,
};

/** One page of `GET /cases`; the previous page stays on screen while the next loads. */
export const useCasesList = (query: CaseListParams) =>
  useQuery({
    queryKey: caseKeys.list(query),
    queryFn: ({ signal }) => cases.list(query, signal),
    placeholderData: keepPreviousData,
  });
