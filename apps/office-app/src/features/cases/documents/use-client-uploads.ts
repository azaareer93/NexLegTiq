import { clientUploadsApi } from '@nexlegtiq/shared-api-client';
import type {
  AcceptClientUploadRequest,
  RejectClientUploadRequest,
} from '@nexlegtiq/shared-contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { documentKeys } from './use-documents';
import { apiClient } from '../../auth';
import { caseKeys } from '../api/use-cases';

const uploads = clientUploadsApi(apiClient);

export const clientUploadKeys = {
  file: (fileId: string) => ['client-uploads', 'file', fileId] as const,
};

export const useClientUploads = (fileId: string) =>
  useQuery({
    queryKey: clientUploadKeys.file(fileId),
    queryFn: ({ signal }) => uploads.forFile(fileId, signal),
  });

export const useOpenClientUpload = () =>
  useMutation({
    mutationFn: async (id: string) => (await uploads.downloadLink(id)).downloadUrl,
    gcTime: 0,
  });

/** Accepting files a document, so the documents (and the file's counts) refresh too. */
export const useAcceptClientUpload = (fileId: string) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: AcceptClientUploadRequest }) =>
      uploads.accept(id, body),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: clientUploadKeys.file(fileId) });
      void queryClient.invalidateQueries({ queryKey: documentKeys.file(fileId) });
      void queryClient.invalidateQueries({ queryKey: caseKeys.detail(fileId) });
    },
  });
};

export const useRejectClientUpload = (fileId: string) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: RejectClientUploadRequest }) =>
      uploads.reject(id, body),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: clientUploadKeys.file(fileId) });
    },
  });
};
