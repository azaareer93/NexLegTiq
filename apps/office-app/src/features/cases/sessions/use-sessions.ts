import { sessionsApi } from '@nexlegtiq/shared-api-client';
import type { FileSessionsParams } from '@nexlegtiq/shared-api-client';
import type { CancelSessionRequest, SessionOutcomeSchema } from '@nexlegtiq/shared-contracts';
import { DEFAULT_TIME_ZONE } from '@nexlegtiq/shared-utils';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';

import type { CreateSessionBody, UpdateSessionBody } from './session-form';
import { apiClient, useSession } from '../../auth';

const sessions = sessionsApi(apiClient);

/** The office's time zone, in which hearing times are entered and shown (D-127). */
const isZone = (zone: string) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};

export const useOfficeTimeZone = (): string => {
  const zone = useSession((state) => state.user?.timeZone);
  // An unknown zone (an office row written before D-125's validation) falls back, as NexProvider's formatting does.
  return zone && isZone(zone) ? zone : DEFAULT_TIME_ZONE;
};

export const sessionKeys = {
  all: ['sessions'] as const,
  file: (fileId: string) => [...sessionKeys.all, 'file', fileId] as const,
  list: (fileId: string, query: FileSessionsParams) =>
    [...sessionKeys.file(fileId), query] as const,
  detail: (id: string) => [...sessionKeys.all, 'detail', id] as const,
};

/** One page of a file's hearings (`when`: upcoming soonest first, past latest first). */
export const useFileSessions = (fileId: string, query: FileSessionsParams) =>
  useQuery({
    queryKey: sessionKeys.list(fileId, query),
    queryFn: ({ signal }) => sessions.forFile(fileId, query, signal),
    placeholderData: keepPreviousData,
  });

/** One hearing with its minutes and reminders (the drawer). */
export const useHearing = (id: string | null) =>
  useQuery({
    queryKey: sessionKeys.detail(id ?? ''),
    queryFn: ({ signal }) => sessions.get(id ?? '', signal),
    enabled: id !== null,
  });

/**
 * Every write refreshes the file's lists and the next-hearing card (they share `sessionKeys.file`) and caches the answer;
 * the calendar and other files' lists hold no copy that needs it.
 */
function useSessionWrite<B>(write: (body: B) => ReturnType<typeof sessions.get>, fileId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: write,
    onSuccess: (session) => {
      queryClient.setQueryData(sessionKeys.detail(session.id), session);
      void queryClient.invalidateQueries({ queryKey: sessionKeys.file(fileId) });
    },
  });
}

export const useCreateSession = (fileId: string) =>
  useSessionWrite((body: CreateSessionBody) => sessions.create(body), fileId);

export const useUpdateSession = (id: string, fileId: string) =>
  useSessionWrite((body: UpdateSessionBody) => sessions.update(id, body), fileId);

export const useCancelSession = (id: string, fileId: string) =>
  useSessionWrite((body: CancelSessionRequest) => sessions.cancel(id, body), fileId);

export const useRecordOutcome = (id: string, fileId: string) =>
  useSessionWrite(
    (body: z.input<typeof SessionOutcomeSchema>) => sessions.outcome(id, body),
    fileId,
  );
