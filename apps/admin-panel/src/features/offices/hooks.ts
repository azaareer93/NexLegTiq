import { ApiError, adminOfficesApi, adminPaymentsApi } from '@nexlegtiq/shared-api-client';
import type { AdminOfficeListParams } from '@nexlegtiq/shared-api-client';
import type {
  AdminOfficeDetail,
  RecordPaymentRequest,
  SubscriptionActionRequest,
} from '@nexlegtiq/shared-contracts';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { officeKeys } from './keys';
import { apiClient } from '../auth/session';
import { planKeys } from '../plans/keys';

const offices = adminOfficesApi(apiClient);
const payments = adminPaymentsApi(apiClient);

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

/** Change plan / extend / set trial; the answer replaces the cached detail. */
export function useSubscriptionAction(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: SubscriptionActionRequest): Promise<AdminOfficeDetail> =>
      offices.changeSubscription(id, body),
    gcTime: 0,
    onSuccess: (office) => {
      queryClient.setQueryData(officeKeys.detail(id), office);
      void queryClient.invalidateQueries({ queryKey: officeKeys.lists() });
      void queryClient.invalidateQueries({ queryKey: planKeys.all });
    },
  });
}

/** Suspend (reason required) or reactivate; the answer replaces the cached detail and lists refetch. */
export function useOfficeAction(id: string, kind: 'suspend' | 'reactivate') {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (reason: string): Promise<AdminOfficeDetail> =>
      kind === 'suspend'
        ? offices.suspend(id, { reason })
        : offices.reactivate(id, reason ? { reason } : {}),
    gcTime: 0,
    onSuccess: (office) => {
      queryClient.setQueryData(officeKeys.detail(id), office);
      void queryClient.invalidateQueries({ queryKey: officeKeys.lists() });
    },
  });
}

export const usePayments = (officeId: string) =>
  useQuery({
    queryKey: officeKeys.payments(officeId),
    queryFn: ({ signal }) => payments.list(officeId, signal),
  });

/** Record or void a payment of the office; the list refetches. Neither touches the subscription (D-174). */
export function usePaymentMutations(officeId: string) {
  const queryClient = useQueryClient();
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: officeKeys.payments(officeId) });
  return {
    record: useMutation({
      mutationFn: (body: RecordPaymentRequest) => payments.record(officeId, body),
      gcTime: 0,
      onSuccess: refresh,
    }),
    void: useMutation({
      mutationFn: ({ id, reason }: { id: string; reason: string }) => payments.void(id, reason),
      gcTime: 0,
      onSuccess: refresh,
    }),
    receipt: useMutation({ mutationFn: (id: string) => payments.receipt(id), gcTime: 0 }),
  };
}
