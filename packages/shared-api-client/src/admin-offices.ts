import { AdminOfficeDetailSchema, AdminOfficeListItemSchema } from '@nexlegtiq/shared-contracts';
import type {
  AdminOfficeDetail,
  AdminOfficeListItem,
  AdminOfficeQuerySchema,
  ReactivateOfficeRequest,
  SubscriptionActionRequest,
  SuspendOfficeRequest,
} from '@nexlegtiq/shared-contracts';
import type { z } from 'zod';

import type { ApiClient, Page } from './api-client.js';

/** `GET /admin/offices` parameters as they travel in the query string (`AdminOfficeQuerySchema` input). */
export type AdminOfficeListParams = Partial<
  Record<keyof z.input<typeof AdminOfficeQuerySchema>, string>
>;

/** Platform admin: offices, their suspension (MVP-102) and subscription actions (MVP-151). */
export function adminOfficesApi(client: ApiClient) {
  const path = (id: string) => `admin/offices/${encodeURIComponent(id)}`;
  return {
    list: (
      query: AdminOfficeListParams,
      signal?: AbortSignal,
    ): Promise<Page<AdminOfficeListItem>> =>
      client.requestPage(
        { method: 'GET', path: 'admin/offices', query, signal },
        AdminOfficeListItemSchema,
      ),
    get: (id: string, signal?: AbortSignal): Promise<AdminOfficeDetail> =>
      client.request({ method: 'GET', path: path(id), signal }, AdminOfficeDetailSchema),
    suspend: (id: string, body: SuspendOfficeRequest): Promise<AdminOfficeDetail> =>
      client.request(
        { method: 'POST', path: `${path(id)}/suspend`, body },
        AdminOfficeDetailSchema,
      ),
    reactivate: (id: string, body: ReactivateOfficeRequest): Promise<AdminOfficeDetail> =>
      client.request(
        { method: 'POST', path: `${path(id)}/reactivate`, body },
        AdminOfficeDetailSchema,
      ),
    /** Change plan, extend the paid period or start/extend a trial (MVP-151). */
    changeSubscription: (id: string, body: SubscriptionActionRequest): Promise<AdminOfficeDetail> =>
      client.request(
        { method: 'POST', path: `${path(id)}/subscription`, body },
        AdminOfficeDetailSchema,
      ),
  };
}
