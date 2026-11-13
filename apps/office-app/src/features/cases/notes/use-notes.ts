import { casesApi, clientProfileApi } from '@nexlegtiq/shared-api-client';
import type { CreateNoteRequest, UpdateNoteRequest } from '@nexlegtiq/shared-contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiClient } from '../../auth';
import { clientKeys } from '../../clients/api/use-clients';
import { caseKeys } from '../api/use-cases';

const cases = casesApi(apiClient);
const clients = clientProfileApi(apiClient);

/** What the notes are about: a file (D-154) or a client (D-168). */
export type NoteSubject = { readonly fileId: string } | { readonly clientId: string };

/** Under the subject's detail key: the page's refresh after any write reaches them too. */
export const noteKeys = {
  file: (fileId: string) => [...caseKeys.detail(fileId), 'notes'] as const,
  client: (clientId: string) => [...clientKeys.detail(clientId), 'notes'] as const,
};

/** The same four calls on either resource. */
const target = (subject: NoteSubject) =>
  'fileId' in subject
    ? { id: subject.fileId, api: cases, key: noteKeys.file(subject.fileId) }
    : { id: subject.clientId, api: clients, key: noteKeys.client(subject.clientId) };

export const useNotes = (subject: NoteSubject) => {
  const { id, api, key } = target(subject);
  return useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api.notes(id, signal),
    // Confidential bodies come back decrypted: never keep them once the tab is gone.
    gcTime: 0,
  });
};

export function useNoteMutations(subject: NoteSubject) {
  const queryClient = useQueryClient();
  const { id, api, key } = target(subject);
  const onSuccess = () => {
    void queryClient.invalidateQueries({ queryKey: key });
    // The file's counts include its notes.
    if ('fileId' in subject) {
      void queryClient.invalidateQueries({ queryKey: caseKeys.detail(id), exact: true });
    }
  };
  // A confidential body is plain text in the request: not kept once the call is done.
  return {
    add: useMutation({
      gcTime: 0,
      mutationFn: (body: CreateNoteRequest) => api.addNote(id, body),
      onSuccess,
    }),
    update: useMutation({
      gcTime: 0,
      mutationFn: ({ id: noteId, body }: { id: string; body: UpdateNoteRequest }) =>
        api.updateNote(id, noteId, body),
      onSuccess,
    }),
    remove: useMutation({ mutationFn: (noteId: string) => api.removeNote(id, noteId), onSuccess }),
  };
}
