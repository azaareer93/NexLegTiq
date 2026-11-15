import {
  OfficeExportDownloadSchema,
  OfficeExportSchema,
  UserExportSchema,
} from '@nexlegtiq/shared-contracts';
import type { OfficeExport, OfficeExportDownload, UserExport } from '@nexlegtiq/shared-contracts';

import type { ApiClient } from './api-client.js';

/** Data exports (D-184): the office's ZIP and the user's own data. */
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
  };
}
