import { witnessesApi } from '@nexlegtiq/shared-api-client';
import type {
  CreateWitnessRequest,
  CreateWitnessStatementRequest,
  UpdateWitnessRequest,
  UpdateWitnessStatementRequest,
} from '@nexlegtiq/shared-contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiClient } from '../../auth';
import { caseKeys } from '../api/use-cases';

const api = witnessesApi(apiClient);

/** Under the file's detail key, so the file page's refreshes reach them too. */
export const witnessKeys = {
  file: (fileId: string) => [...caseKeys.detail(fileId), 'witnesses'] as const,
  statements: (fileId: string, witnessId: string) =>
    [...witnessKeys.file(fileId), witnessId, 'statements'] as const,
};

export const useWitnesses = (fileId: string) =>
  useQuery({
    queryKey: witnessKeys.file(fileId),
    queryFn: ({ signal }) => api.forFile(fileId, signal),
  });

export function useWitnessMutations(fileId: string) {
  const queryClient = useQueryClient();
  const onSuccess = () =>
    void queryClient.invalidateQueries({ queryKey: witnessKeys.file(fileId) });
  return {
    create: useMutation({
      mutationFn: (body: CreateWitnessRequest) => api.create(fileId, body),
      onSuccess,
    }),
    update: useMutation({
      mutationFn: ({ id, body }: { id: string; body: UpdateWitnessRequest }) =>
        api.update(fileId, id, body),
      onSuccess,
    }),
    remove: useMutation({ mutationFn: (id: string) => api.remove(fileId, id), onSuccess }),
  };
}

export const useStatements = (fileId: string, witnessId: string) =>
  useQuery({
    queryKey: witnessKeys.statements(fileId, witnessId),
    queryFn: ({ signal }) => api.statements(witnessId, signal),
    // Testimony is case content: not kept once the drawer is closed.
    gcTime: 0,
  });

export function useStatementMutations(fileId: string, witnessId: string) {
  const queryClient = useQueryClient();
  // The witness list carries the statement count; the timeline gets an event on add.
  const onSuccess = () => {
    void queryClient.invalidateQueries({ queryKey: witnessKeys.file(fileId) });
    void queryClient.invalidateQueries({ queryKey: [...caseKeys.detail(fileId), 'timeline'] });
  };
  return {
    create: useMutation({
      mutationFn: (body: CreateWitnessStatementRequest) => api.addStatement(witnessId, body),
      onSuccess,
    }),
    update: useMutation({
      mutationFn: ({ id, body }: { id: string; body: UpdateWitnessStatementRequest }) =>
        api.updateStatement(witnessId, id, body),
      onSuccess,
    }),
    remove: useMutation({
      mutationFn: (id: string) => api.removeStatement(witnessId, id),
      onSuccess,
    }),
  };
}
