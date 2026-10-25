import { ApiError, casesApi, courtsApi, usersApi } from '@nexlegtiq/shared-api-client';
import type { CaseListParams } from '@nexlegtiq/shared-api-client';
import type {
  AddFileClientRequest,
  AddTeamMemberRequest,
  Case,
  CreateCaseSchema,
  CreateCourtSchema,
  CreateJudgeSchema,
  UpdateCaseRequest,
} from '@nexlegtiq/shared-contracts';
import type { FileTeamRole } from '@nexlegtiq/shared-types';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';

import { apiClient } from '../../auth';

const cases = casesApi(apiClient);
const users = usersApi(apiClient);
const courts = courtsApi(apiClient);

type CreateCaseInput = z.input<typeof CreateCaseSchema>;
type CreateCourtInput = z.input<typeof CreateCourtSchema>;
type CreateJudgeInput = z.input<typeof CreateJudgeSchema>;

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

/**
 * `GET /cases/:id`. A missing, invisible or other office's file is 404 RES-001 (D-019); like every 4xx it is final, so
 * only a network or server failure is retried (once, as the app default).
 */
export const useCase = (id: string, enabled = true) =>
  useQuery({
    queryKey: caseKeys.detail(id),
    queryFn: ({ signal }) => cases.get(id, signal),
    enabled,
    retry: (count, error) =>
      count < 1 && !(error instanceof ApiError && error.status >= 400 && error.status < 500),
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

/**
 * `DELETE /cases/:id` (soft delete): the file leaves every cached list. The page drops the detail itself once it has
 * navigated away (dropping it here would refetch it while the page still watches it).
 */
export function useDeleteCase(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => cases.remove(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: caseKeys.lists() }),
  });
}

/** `POST /cases`: lists refetch; the new file is cached for "Create & open". */
export function useCreateCase() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateCaseInput) => cases.create(body),
    onSuccess: (file: Case) => {
      queryClient.setQueryData(caseKeys.detail(file.id), file);
      void queryClient.invalidateQueries({ queryKey: caseKeys.lists() });
    },
  });
}

/** After a change to a file's people: the file (its cards and counts) and the lists (primary client, lawyer) refetch. */
function useRefreshFile(id: string) {
  const queryClient = useQueryClient();
  return (extra: readonly (readonly unknown[])[] = []) =>
    Promise.all(
      [caseKeys.detail(id), caseKeys.lists(), ...extra].map((queryKey) =>
        queryClient.invalidateQueries({ queryKey }),
      ),
    );
}

/** Adding, making primary and removing a file's clients (D-140). */
export function useFileClientMutations(id: string) {
  const refresh = useRefreshFile(id);
  const onSuccess = () => refresh();
  return {
    addClient: useMutation({
      mutationFn: (body: AddFileClientRequest) => cases.addClient(id, body),
      onSuccess,
    }),
    makePrimary: useMutation({
      mutationFn: (clientId: string) => cases.makePrimaryClient(id, clientId),
      onSuccess,
    }),
    removeClient: useMutation({
      mutationFn: (clientId: string) => cases.removeClient(id, clientId),
      onSuccess,
    }),
  };
}

/**
 * Adding, re-roling and removing a file's team members (D-140). A new responsible lawyer also changes the reminders of
 * the file's hearings (D-117), so hearing queries refetch too.
 */
export function useFileTeamMutations(id: string) {
  const refresh = useRefreshFile(id);
  const after = (role?: FileTeamRole) =>
    refresh(role === 'RESPONSIBLE_LAWYER' ? [['sessions']] : []);
  return {
    addMember: useMutation({
      mutationFn: (body: AddTeamMemberRequest) => cases.addTeamMember(id, body),
      onSuccess: (_data, body) => after(body.role),
    }),
    changeRole: useMutation({
      mutationFn: ({ userId, role }: { userId: string; role: FileTeamRole }) =>
        cases.changeTeamRole(id, userId, role),
      onSuccess: (_data, { role }) => after(role),
    }),
    removeMember: useMutation({
      mutationFn: (userId: string) => cases.removeTeamMember(id, userId),
      onSuccess: () => after(),
    }),
  };
}

/** Active colleagues for the lawyer and paralegal pickers (D-123); changes rarely. */
export const useDirectory = (enabled = true) =>
  useQuery({
    queryKey: ['users', 'directory'] as const,
    queryFn: ({ signal }) => users.directory(signal),
    staleTime: 5 * 60_000,
    enabled,
  });

/** Courts matching `search` (Arabic or English name, city), 20 at a time. */
export const useCourts = (search: string, enabled: boolean) =>
  useQuery({
    queryKey: ['courts', 'list', search] as const,
    queryFn: ({ signal }) => courts.list({ limit: '20', ...(search ? { search } : {}) }, signal),
    placeholderData: keepPreviousData,
    enabled,
  });

/** The judges of a court (active first), once a court is picked. */
export const useJudges = (courtId: string | undefined) =>
  useQuery({
    queryKey: ['courts', 'judges', courtId] as const,
    queryFn: ({ signal }) => courts.judges(courtId ?? '', signal),
    enabled: courtId !== undefined,
  });

/** `POST /courts`: an office court (D-115); court searches refetch. */
export function useCreateCourt() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateCourtInput) => courts.create(body),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['courts', 'list'] }),
  });
}

/** `POST /courts/:id/judges`: an office judge at that court; its judge list refetches. */
export function useCreateJudge(courtId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateJudgeInput) => courts.createJudge(courtId ?? '', body),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ['courts', 'judges', courtId] }),
  });
}
