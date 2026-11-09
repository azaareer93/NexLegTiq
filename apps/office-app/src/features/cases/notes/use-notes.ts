import { casesApi } from '@nexlegtiq/shared-api-client';
import type { CreateNoteRequest, UpdateNoteRequest } from '@nexlegtiq/shared-contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiClient } from '../../auth';
import { caseKeys } from '../api/use-cases';

const cases = casesApi(apiClient);

/** Under the file's detail key: the file page's refresh after any write reaches them too. */
export const noteKeys = {
  file: (fileId: string) => [...caseKeys.detail(fileId), 'notes'] as const,
};

export const useNotes = (fileId: string) =>
  useQuery({
    queryKey: noteKeys.file(fileId),
    queryFn: ({ signal }) => cases.notes(fileId, signal),
    // Confidential bodies come back decrypted: never keep them once the tab is gone.
    gcTime: 0,
  });

export function useNoteMutations(fileId: string) {
  const queryClient = useQueryClient();
  const onSuccess = () => {
    void queryClient.invalidateQueries({ queryKey: noteKeys.file(fileId) });
    // The file's counts include its notes.
    void queryClient.invalidateQueries({ queryKey: caseKeys.detail(fileId), exact: true });
  };
  return {
    add: useMutation({
      mutationFn: (body: CreateNoteRequest) => cases.addNote(fileId, body),
      onSuccess,
    }),
    update: useMutation({
      mutationFn: ({ id, body }: { id: string; body: UpdateNoteRequest }) =>
        cases.updateNote(fileId, id, body),
      onSuccess,
    }),
    remove: useMutation({ mutationFn: (id: string) => cases.removeNote(fileId, id), onSuccess }),
  };
}
