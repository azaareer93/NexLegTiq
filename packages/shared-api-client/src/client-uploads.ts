import { ClientUploadSchema, DownloadLinkSchema } from '@nexlegtiq/shared-contracts';
import type {
  AcceptClientUploadRequest,
  ClientUpload,
  DownloadLink,
  RejectClientUploadRequest,
} from '@nexlegtiq/shared-contracts';

import type { ApiClient } from './api-client.js';

/** Review queue of what clients sent through the portal (MVP-99, D-187). */
export function clientUploadsApi(client: ApiClient) {
  const path = (id: string) => `client-uploads/${encodeURIComponent(id)}`;
  return {
    forFile: (fileId: string, signal?: AbortSignal): Promise<ClientUpload[]> =>
      client.request(
        { method: 'GET', path: `cases/${encodeURIComponent(fileId)}/client-uploads`, signal },
        ClientUploadSchema.array(),
      ),
    /** A short-lived link; only while PENDING_REVIEW (404 otherwise). */
    downloadLink: (id: string, signal?: AbortSignal): Promise<DownloadLink> =>
      client.request({ method: 'GET', path: `${path(id)}/download`, signal }, DownloadLinkSchema),
    /** Files the upload as a document; 422 BIZ-028 / BIZ-015 / BIZ-007. */
    accept: (id: string, body: AcceptClientUploadRequest): Promise<ClientUpload> =>
      client.request({ method: 'POST', path: `${path(id)}/accept`, body }, ClientUploadSchema),
    reject: (id: string, body: RejectClientUploadRequest): Promise<ClientUpload> =>
      client.request({ method: 'POST', path: `${path(id)}/reject`, body }, ClientUploadSchema),
  };
}
