import { partiesApi } from '@nexlegtiq/shared-api-client';
import type { AddFilePartyRequest, UpdateFilePartyRequest } from '@nexlegtiq/shared-contracts';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiClient } from '../../auth';
import { caseKeys } from '../api/use-cases';

const parties = partiesApi(apiClient);

export const partyKeys = {
  file: (fileId: string) => ['parties', 'file', fileId] as const,
  search: (search: string) => ['parties', 'search', search] as const,
  /** Open conflicts touching the file (banner and modal). */
  conflicts: (fileId: string) => ['parties', 'conflicts', fileId] as const,
};

/** The modal lists the first 100 open conflicts; the banner counts them all (the page total). */
const CONFLICT_PAGE = 100;

export const useFileParties = (fileId: string) =>
  useQuery({
    queryKey: partyKeys.file(fileId),
    queryFn: ({ signal }) => parties.forFile(fileId, signal),
  });

/** The registry picker: only once something is typed (the list is office-wide). */
export const usePartySearch = (search: string) =>
  useQuery({
    queryKey: partyKeys.search(search),
    queryFn: ({ signal }) => parties.search(search, signal),
    enabled: search.length > 0,
    placeholderData: keepPreviousData,
  });

export const useOpenConflicts = (fileId: string) =>
  useQuery({
    queryKey: partyKeys.conflicts(fileId),
    queryFn: ({ signal }) =>
      parties.conflicts({ fileId, resolved: 'false', limit: String(CONFLICT_PAGE) }, signal),
  });

/** Every write refreshes the file's parties, its open conflicts and its detail (the parties count). */
function usePartyWrite<A, R>(fileId: string, write: (args: A) => Promise<R>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: write,
    onSettled: () => {
      // Every parties query: the other file's conflicts and the registry search change too.
      void queryClient.invalidateQueries({ queryKey: ['parties'] });
      void queryClient.invalidateQueries({ queryKey: caseKeys.detail(fileId) });
    },
  });
}

export const useAddParty = (fileId: string) =>
  usePartyWrite(fileId, (body: AddFilePartyRequest) => parties.add(fileId, body));

export const useUpdateParty = (fileId: string) =>
  usePartyWrite(fileId, ({ id, body }: { id: string; body: UpdateFilePartyRequest }) =>
    parties.update(fileId, id, body),
  );

export const useRemoveParty = (fileId: string) =>
  usePartyWrite(fileId, (id: string) => parties.remove(fileId, id));

export const useResolveConflict = (fileId: string) =>
  usePartyWrite(fileId, ({ id, notes }: { id: string; notes: string }) =>
    parties.resolve(id, notes),
  );
