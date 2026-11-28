import {
  OfficeDeletionStatusSchema,
  OfficeExportDownloadSchema,
  OfficeExportSchema,
  UserExportSchema,
} from '@nexlegtiq/shared-contracts';
import type {
  OfficeDeletionStatus,
  OfficeExport,
  OfficeExportDownload,
  RequestOfficeDeletionRequest,
  UserExport,
} from '@nexlegtiq/shared-contracts';

import type { ApiClient } from './api-client.js';

/** Data rights (D-184, D-251): the office's ZIP export, the user's own data, and the office's deletion. */
export function exportsApi(client: ApiClient) {
  return {
    requestOffice: (): Promise<OfficeExport> =>
      client.request({ method: 'POST', path: 'offices/me/export' }, OfficeExportSchema),
    listOffice: (signal?: AbortSignal): Promise<OfficeExport[]> =>
      client.request(
        { method: 'GET', path: 'offices/me/exports', signal },
        OfficeExportSchema.array(),
      ),
    download: (id: string): Promise<OfficeExportDownload> =>
      client.request(
        { method: 'GET', path: `offices/me/exports/${encodeURIComponent(id)}/download` },
        OfficeExportDownloadSchema,
      ),
    mine: (): Promise<UserExport> =>
      client.request({ method: 'GET', path: 'users/me/export' }, UserExportSchema),
    deletion: (signal?: AbortSignal): Promise<OfficeDeletionStatus> =>
      client.request(
        { method: 'GET', path: 'offices/me/delete-request', signal },
        OfficeDeletionStatusSchema,
      ),
    requestDeletion: (body: RequestOfficeDeletionRequest): Promise<OfficeDeletionStatus> =>
      client.request(
        { method: 'POST', path: 'offices/me/delete-request', body },
        OfficeDeletionStatusSchema,
      ),
    cancelDeletion: (): Promise<OfficeDeletionStatus> =>
      client.request(
        { method: 'POST', path: 'offices/me/delete-request/cancel' },
        OfficeDeletionStatusSchema,
      ),
  };
}
