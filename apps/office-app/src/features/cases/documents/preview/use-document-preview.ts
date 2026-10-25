import { documentsApi } from '@nexlegtiq/shared-api-client';
import type { VersionInput } from '@nexlegtiq/shared-api-client';
import type { Document } from '@nexlegtiq/shared-contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiClient } from '../../../auth';
import { caseKeys } from '../../api/use-cases';
import { documentKeys } from '../use-documents';

const documents = documentsApi(apiClient);

/**
 * One document's queries sit under its file's key, so every document write and the realtime `document.processed`
 * refresh (D-129) reach them. The bytes have their own prefix: refetching them asks for a new, audited link.
 */
export const previewKeys = {
  document: (fileId: string, id: string) => [...documentKeys.file(fileId), 'document', id] as const,
  versions: (fileId: string, id: string) =>
    [...previewKeys.document(fileId, id), 'versions'] as const,
  text: (fileId: string, id: string, version: number, page: number) =>
    [...previewKeys.document(fileId, id), 'text', version, page] as const,
  bytes: (id: string, version: number) => ['document-bytes', id, version] as const,
};

export type PreviewKind = 'pdf' | 'image';

/** What the drawer can draw itself: PDFs with pdf.js, PNG and JPEG as images (browsers cannot show TIFF). */
export const previewKind = (mimeType: string): PreviewKind | null => {
  if (mimeType === 'application/pdf') return 'pdf';
  return mimeType === 'image/png' || mimeType === 'image/jpeg' ? 'image' : null;
};

/** A storage failure in the shape the shared error handling reads (D-093): STO-002, "could not be downloaded". */
const storageError = (): Error =>
  Object.assign(new Error('storage fetch failed'), { code: 'STO-002' });

/**
 * The current version's bytes (D-143): an audited link from the API, then the app fetches them itself — no cookie or
 * token goes to the storage host, and the attachment it serves is never rendered by the browser from there.
 */
async function fetchBytes(id: string, signal: AbortSignal): Promise<Blob> {
  const { downloadUrl } = await documents.downloadLink(id, signal);
  let response: Response;
  try {
    response = await fetch(downloadUrl, {
      signal,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw storageError();
  }
  if (!response.ok) throw storageError();
  return response.blob();
}

export const useDocumentDetail = (fileId: string, id: string) =>
  useQuery({
    queryKey: previewKeys.document(fileId, id),
    queryFn: ({ signal }) => documents.get(id, signal),
  });

export const useDocumentVersions = (fileId: string, id: string) =>
  useQuery({
    queryKey: previewKeys.versions(fileId, id),
    queryFn: ({ signal }) => documents.versions(id, signal),
  });

/** A page of the extracted text; every read is an audit row (D-128), so it is fetched only when the tab is shown. */
export const useDocumentText = (fileId: string, document: Document, page: number) =>
  useQuery({
    queryKey: previewKeys.text(fileId, document.id, document.currentVersion, page),
    queryFn: ({ signal }) => documents.text(document.id, page, signal),
    retry: false,
  });

/** Bytes are kept only while shown (up to 50 MB each) and never retried on their own (each try is an audited link). */
export const useDocumentBytes = (document: Document, enabled: boolean) =>
  useQuery({
    queryKey: previewKeys.bytes(document.id, document.currentVersion),
    queryFn: ({ signal }) => fetchBytes(document.id, signal),
    enabled,
    retry: false,
    gcTime: 0,
    staleTime: Infinity,
  });

/** "Download": a fresh link, opened as the attachment the storage serves under the version's own name. */
export const useDownloadDocument = () =>
  useMutation({
    mutationFn: async (id: string) => (await documents.downloadLink(id)).downloadUrl,
  });

export const useUploadVersion = (fileId: string, id: string) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      input,
      onProgress,
    }: {
      input: VersionInput;
      onProgress: (fraction: number) => void;
    }) => documents.uploadVersion(id, input, { onProgress }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: documentKeys.file(fileId) });
      void queryClient.invalidateQueries({ queryKey: caseKeys.detail(fileId) });
    },
  });
};
