import { timeEntriesApi } from '@nexlegtiq/shared-api-client';
import type {
  CreateTimeEntryRequest,
  StopTimerRequest,
  UpdateTimeEntryRequest,
} from '@nexlegtiq/shared-contracts';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiClient } from '../../auth';

const entries = timeEntriesApi(apiClient);

export const timeKeys = {
  all: ['time-entries'] as const,
  list: (fileId: string, page: number) => [...timeKeys.all, 'list', fileId, page] as const,
  totals: (fileId: string) => [...timeKeys.all, 'totals', fileId] as const,
  timer: () => [...timeKeys.all, 'timer'] as const,
};

export const PAGE_SIZE = 20;

export const useTimeEntries = (fileId: string, page: number) =>
  useQuery({
    queryKey: timeKeys.list(fileId, page),
    queryFn: ({ signal }) =>
      entries.list({ fileId, page: String(page), limit: String(PAGE_SIZE) }, signal),
    placeholderData: keepPreviousData,
  });

export const useTimeTotals = (fileId: string) =>
  useQuery({
    queryKey: timeKeys.totals(fileId),
    queryFn: ({ signal }) => entries.totals(fileId, signal),
  });

export const useTimer = (enabled: boolean) =>
  useQuery({
    queryKey: timeKeys.timer(),
    queryFn: ({ signal }) => entries.timer(signal),
    enabled,
  });

/** Every write refreshes lists, totals and the timer together (an entry changes all three). */
export function useTimeMutations() {
  const queryClient = useQueryClient();
  const onSuccess = () => queryClient.invalidateQueries({ queryKey: timeKeys.all });
  return {
    create: useMutation({
      mutationFn: (body: CreateTimeEntryRequest) => entries.create(body),
      onSuccess,
    }),
    update: useMutation({
      mutationFn: ({ id, body }: { id: string; body: UpdateTimeEntryRequest }) =>
        entries.update(id, body),
      onSuccess,
    }),
    remove: useMutation({ mutationFn: (id: string) => entries.remove(id), onSuccess }),
    start: useMutation({
      mutationFn: (fileId: string) => entries.startTimer({ fileId }),
      onSuccess,
    }),
    stop: useMutation({
      mutationFn: (body: StopTimerRequest) => entries.stopTimer(body),
      onSuccess,
    }),
    discard: useMutation({ mutationFn: () => entries.discardTimer(), onSuccess }),
  };
}
