import {
  AdminAuditPageSchema,
  AdminQueueSchema,
  AdminUsageSchema,
} from '@nexlegtiq/shared-contracts';
import type {
  AdminAuditExportQuery,
  AdminAuditPage,
  AdminAuditQuery,
  AdminQueue,
  AdminUsage,
} from '@nexlegtiq/shared-contracts';

import type { ApiClient } from './api-client.js';

const params = (query: object) =>
  Object.fromEntries(
    Object.entries(query).filter(([, v]) => v !== undefined && v !== ''),
  ) as Record<string, string | number>;

/** Platform usage, queue health and the platform audit (D-183). */
export function adminUsageApi(client: ApiClient) {
  return {
    usage: (days: number, signal?: AbortSignal): Promise<AdminUsage> =>
      client.request(
        { method: 'GET', path: 'admin/usage', query: { days }, signal },
        AdminUsageSchema,
      ),
    queues: (signal?: AbortSignal): Promise<AdminQueue[]> =>
      client.request({ method: 'GET', path: 'admin/queues', signal }, AdminQueueSchema.array()),
    audit: (query: Partial<AdminAuditQuery>, signal?: AbortSignal): Promise<AdminAuditPage> =>
      client.request(
        { method: 'GET', path: 'admin/audit', query: params(query), signal },
        AdminAuditPageSchema,
      ),
    exportAudit: (query: Partial<AdminAuditExportQuery>): Promise<string> =>
      client.requestText({ method: 'GET', path: 'admin/audit/export', query: params(query) }),
  };
}
