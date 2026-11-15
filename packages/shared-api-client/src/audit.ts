import { AuditPageSchema } from '@nexlegtiq/shared-contracts';
import type { AuditExportQuery, AuditPage, AuditQuery } from '@nexlegtiq/shared-contracts';

import type { ApiClient } from './api-client.js';

/** Filters as query strings: undefined ones are left out. */
const params = (query: Partial<AuditQuery>) =>
  Object.fromEntries(
    Object.entries(query).filter(([, value]) => value !== undefined && value !== ''),
  ) as Record<string, string | number>;

/** The audit log (D-180): the office's, a file's, and the office's as CSV. */
export function auditApi(client: ApiClient) {
  return {
    list: (query: Partial<AuditQuery>, signal?: AbortSignal): Promise<AuditPage> =>
      client.request(
        { method: 'GET', path: 'audit', query: params(query), signal },
        AuditPageSchema,
      ),
    file: (fileId: string, query: Partial<AuditQuery>, signal?: AbortSignal): Promise<AuditPage> =>
      client.request(
        {
          method: 'GET',
          path: `cases/${encodeURIComponent(fileId)}/audit`,
          query: params(query),
          signal,
        },
        AuditPageSchema,
      ),
    exportCsv: (query: Partial<AuditExportQuery>): Promise<string> =>
      client.requestText({
        method: 'GET',
        path: 'audit/export',
        query: params({ ...query, format: 'csv' } as Partial<AuditQuery>),
      }),
  };
}
