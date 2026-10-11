import { ApiError, casesApi } from '@nexlegtiq/shared-api-client';
import type { CaseListParams } from '@nexlegtiq/shared-api-client';
import type { Case, UpdateCaseRequest } from '@nexlegtiq/shared-contracts';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiClient } from '../../auth';

const cases = casesApi(apiClient);

export const caseKeys = {
  all: ['cases'] as const,
  lists: () => [...caseKeys.all, 'list'] as const,
  list: (query: CaseListParams) => [...caseKeys.lists(), query] as const,
  detail: (id: string) => [...caseKeys.all, 'detail', id] as const,
};

/** One page of `GET /cases`; the previous page stays on screen while the next loads. */
export const useCasesList = (query: CaseListParams) =>
  useQuery({
    queryKey: caseKeys.list(query),
    queryFn: ({ signal }) => cases.list(query, signal),
    placeholderData: keepPreviousData,
  });

/** `GET /cases/:id`. A missing, invisible or other office's file is 404 RES-001 (D-019): never retried. */
export const useCase = (id: string) =>
  useQuery({
    queryKey: caseKeys.detail(id),
    queryFn: ({ signal }) => cases.get(id, signal),
    retry: (count, error) => count < 2 && !(error instanceof ApiError && error.status === 404),
  });

/** `PATCH /cases/:id`: the answer replaces the cached file; lists refetch. */
export function useUpdateCase(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateCaseRequest) => cases.update(id, body),
    onSuccess: (file: Case) => {
      queryClient.setQueryData(caseKeys.detail(id), file);
      void queryClient.invalidateQueries({ queryKey: caseKeys.lists() });
    },
  });
}

/** `DELETE /cases/:id` (soft delete): the file leaves every cached list. */
export function useDeleteCase(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => cases.remove(id),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: caseKeys.detail(id) });
      void queryClient.invalidateQueries({ queryKey: caseKeys.lists() });
    },
  });
}
