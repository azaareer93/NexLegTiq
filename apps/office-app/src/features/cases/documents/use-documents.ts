import { documentsApi, foldersApi } from '@nexlegtiq/shared-api-client';
import type { DocumentListParams, UploadInput } from '@nexlegtiq/shared-api-client';
import type {
  CreateFolderRequest,
  UpdateDocumentRequest,
  UpdateFolderRequest,
} from '@nexlegtiq/shared-contracts';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { PENDING_STATUSES } from './document-upload';
import { apiClient } from '../../auth';
import { caseKeys } from '../api/use-cases';

const documents = documentsApi(apiClient);
const folders = foldersApi(apiClient);

/** Under `documents`: the realtime bridge refreshes every query of this prefix on `document.processed` (D-129). */
export const documentKeys = {
  all: ['documents'] as const,
  file: (fileId: string) => [...documentKeys.all, 'file', fileId] as const,
  list: (fileId: string, query: DocumentListParams) =>
    [...documentKeys.file(fileId), query] as const,
  folders: (fileId: string) => [...documentKeys.file(fileId), 'folders'] as const,
};

/** Seconds between refreshes while a shown document is still being scanned or processed (the socket's fallback). */
export const PENDING_POLL_MS = 10_000;

export const useDocuments = (fileId: string, query: DocumentListParams) =>
  useQuery({
    queryKey: documentKeys.list(fileId, query),
    queryFn: ({ signal }) => documents.forFile(fileId, query, signal),
    placeholderData: keepPreviousData,
    refetchInterval: (state) =>
      state.state.data?.items.some((item) => PENDING_STATUSES.has(item.status))
        ? PENDING_POLL_MS
        : false,
  });

export const useFolders = (fileId: string) =>
  useQuery({
    queryKey: documentKeys.folders(fileId),
    queryFn: ({ signal }) => folders.list(fileId, signal),
  });

/** Every write refreshes the file's documents and folders (counts), and the file's detail (its counts). */
function useDocumentWrite<A, R>(fileId: string, write: (args: A) => Promise<R>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: write,
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: documentKeys.file(fileId) });
      void queryClient.invalidateQueries({ queryKey: caseKeys.detail(fileId) });
    },
  });
}

export const useUploadDocument = (fileId: string) =>
  useDocumentWrite(
    fileId,
    ({
      input,
      onProgress,
      idempotencyKey,
    }: {
      input: UploadInput;
      onProgress: (fraction: number) => void;
      idempotencyKey: string;
    }) => documents.upload(input, { onProgress, idempotencyKey }),
  );

export const useUpdateDocument = (fileId: string) =>
  useDocumentWrite(fileId, ({ id, body }: { id: string; body: UpdateDocumentRequest }) =>
    documents.update(id, body),
  );

export const useDeleteDocument = (fileId: string) =>
  useDocumentWrite(fileId, (id: string) => documents.remove(id));

export const useRetryDocument = (fileId: string) =>
  useDocumentWrite(fileId, (id: string) => documents.retry(id));

export const useCreateFolder = (fileId: string) =>
  useDocumentWrite(fileId, (body: CreateFolderRequest) => folders.create(fileId, body));

export const useRenameFolder = (fileId: string) =>
  useDocumentWrite(fileId, ({ id, body }: { id: string; body: UpdateFolderRequest }) =>
    folders.update(fileId, id, body),
  );
