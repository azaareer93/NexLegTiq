import { adminFileTypesApi } from '@nexlegtiq/shared-api-client';
import type {
  CreateFileSubTypeRequest,
  CreateFileTypeRequest,
  UpdateFileSubTypeRequest,
  UpdateFileTypeRequest,
} from '@nexlegtiq/shared-contracts';
import type { Jurisdiction } from '@nexlegtiq/shared-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiClient } from '../auth/session';

const fileTypes = adminFileTypesApi(apiClient);

export const fileTypeKeys = {
  all: ['admin-file-types'] as const,
  list: (jurisdiction: Jurisdiction) => [...fileTypeKeys.all, 'list', jurisdiction] as const,
};

export const useFileTypesList = (jurisdiction: Jurisdiction) =>
  useQuery({
    queryKey: fileTypeKeys.list(jurisdiction),
    queryFn: ({ signal }) => fileTypes.list(jurisdiction, signal),
  });

/** Create or edit a type or a sub-type; the country's list refetches afterwards. */
export function useFileTypeMutations() {
  const queryClient = useQueryClient();
  const onSuccess = () => queryClient.invalidateQueries({ queryKey: fileTypeKeys.all });
  return {
    create: useMutation({
      mutationFn: (body: CreateFileTypeRequest) => fileTypes.create(body),
      onSuccess,
    }),
    update: useMutation({
      mutationFn: (args: { id: string; body: UpdateFileTypeRequest }) =>
        fileTypes.update(args.id, args.body),
      onSuccess,
    }),
    createSubType: useMutation({
      mutationFn: (args: { typeId: string; body: CreateFileSubTypeRequest }) =>
        fileTypes.createSubType(args.typeId, args.body),
      onSuccess,
    }),
    updateSubType: useMutation({
      mutationFn: (args: { id: string; body: UpdateFileSubTypeRequest }) =>
        fileTypes.updateSubType(args.id, args.body),
      onSuccess,
    }),
  };
}
