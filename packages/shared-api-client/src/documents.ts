import { DocumentSchema, DocumentUploadSchema, FolderSchema } from '@nexlegtiq/shared-contracts';
import type {
  CreateFolderRequest,
  Document,
  DocumentQuerySchema,
  DocumentUpload,
  Folder,
  UpdateDocumentRequest,
  UpdateFolderRequest,
} from '@nexlegtiq/shared-contracts';
import type { DocumentType } from '@nexlegtiq/shared-types';
import type { z } from 'zod';

import type { ApiClient, Page } from './api-client.js';

/** `GET /cases/:id/documents` as the URL and the app hold it: strings, checked by the API. */
export type DocumentListParams = Partial<Record<keyof z.input<typeof DocumentQuerySchema>, string>>;

export interface UploadInput {
  readonly fileId: string;
  readonly file: Blob;
  /** The file's own name (Arabic kept as is, D-035). */
  readonly filename: string;
  readonly documentType?: DocumentType;
  readonly folderId?: string;
}

/** Documents of a file (D-126, D-128, D-132). */
export function documentsApi(client: ApiClient) {
  const path = (id: string) => `documents/${encodeURIComponent(id)}`;
  return {
    forFile: (
      fileId: string,
      query: DocumentListParams,
      signal?: AbortSignal,
    ): Promise<Page<Document>> =>
      client.requestPage(
        { method: 'GET', path: `cases/${encodeURIComponent(fileId)}/documents`, query, signal },
        DocumentSchema,
      ),
    /**
     * Multipart upload (202): the text fields go **before** the file, so the API checks access before storing anything.
     * `onProgress` reports the upload of the body; `idempotencyKey` (one per file the user picked) makes a retry safe.
     */
    upload: (
      input: UploadInput,
      {
        onProgress,
        signal,
        idempotencyKey,
      }: {
        onProgress?: (fraction: number) => void;
        signal?: AbortSignal;
        idempotencyKey?: string;
      } = {},
    ): Promise<DocumentUpload> => {
      const form = new FormData();
      form.append('fileId', input.fileId);
      if (input.documentType) form.append('documentType', input.documentType);
      if (input.folderId) form.append('folderId', input.folderId);
      form.append('file', input.file, input.filename);
      return client.request(
        {
          method: 'POST',
          path: 'documents',
          body: form,
          signal,
          ...(onProgress && { onUploadProgress: onProgress }),
          ...(idempotencyKey && { headers: { 'Idempotency-Key': idempotencyKey } }),
        },
        DocumentUploadSchema,
      );
    },
    update: (id: string, body: UpdateDocumentRequest): Promise<Document> =>
      client.request({ method: 'PATCH', path: path(id), body }, DocumentSchema),
    remove: (id: string): Promise<void> => client.request({ method: 'DELETE', path: path(id) }),
    /** A FAILED document back to the step that failed (202); 422 BIZ-016 otherwise (D-132). */
    retry: (id: string): Promise<Document> =>
      client.request({ method: 'POST', path: `${path(id)}/ocr/retry` }, DocumentSchema),
  };
}

/** Folders of a file (D-119): six system folders plus the office's own. */
export function foldersApi(client: ApiClient) {
  const base = (fileId: string) => `cases/${encodeURIComponent(fileId)}/folders`;
  return {
    list: (fileId: string, signal?: AbortSignal): Promise<Folder[]> =>
      client.request({ method: 'GET', path: base(fileId), signal }, FolderSchema.array()),
    create: (fileId: string, body: CreateFolderRequest): Promise<Folder> =>
      client.request({ method: 'POST', path: base(fileId), body }, FolderSchema),
    update: (fileId: string, folderId: string, body: UpdateFolderRequest): Promise<Folder> =>
      client.request(
        { method: 'PATCH', path: `${base(fileId)}/${encodeURIComponent(folderId)}`, body },
        FolderSchema,
      ),
  };
}
