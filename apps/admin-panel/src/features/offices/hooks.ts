import { ApiError, adminOfficesApi } from '@nexlegtiq/shared-api-client';
import type { AdminOfficeListParams } from '@nexlegtiq/shared-api-client';
import type { AdminOfficeDetail } from '@nexlegtiq/shared-contracts';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { officeKeys } from './keys';
import { apiClient } from '../auth/session';

const offices = adminOfficesApi(apiClient);

export const useOfficesList = (query: AdminOfficeListParams) =>
  useQuery({
    queryKey: officeKeys.list(query),
    queryFn: ({ signal }) => offices.list(query, signal),
    placeholderData: keepPreviousData,
  });

export const useOffice = (id: string) =>
  useQuery({
    queryKey: officeKeys.detail(id),
    queryFn: ({ signal }) => offices.get(id, signal),
    // A 404 will not change on a retry.
    retry: (count, error) =>
      !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 1,
  });

/** Suspend (reason required) or reactivate; the answer replaces the cached detail and lists refetch. */
export function useOfficeAction(id: string, kind: 'suspend' | 'reactivate') {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (reason: string | undefined): Promise<AdminOfficeDetail> =>
      kind === 'suspend'
        ? offices.suspend(id, { reason: reason ?? '' })
        : offices.reactivate(id, reason ? { reason } : {}),
    gcTime: 0,
    onSuccess: (office) => {
      queryClient.setQueryData(officeKeys.detail(id), office);
      void queryClient.invalidateQueries({ queryKey: officeKeys.lists() });
    },
  });
}
