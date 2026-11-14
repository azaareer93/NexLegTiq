import { AdminPlanSchema } from '@nexlegtiq/shared-contracts';
import type { AdminPlan, CreatePlanRequest, UpdatePlanRequest } from '@nexlegtiq/shared-contracts';
import { z } from 'zod';

import type { ApiClient } from './api-client.js';

const PlansSchema = z.array(AdminPlanSchema);

/** Platform admin: the plans offices subscribe to (MVP-151). */
export function adminPlansApi(client: ApiClient) {
  const path = (id: string) => `admin/plans/${encodeURIComponent(id)}`;
  return {
    list: (signal?: AbortSignal): Promise<AdminPlan[]> =>
      client.request({ method: 'GET', path: 'admin/plans', signal }, PlansSchema),
    create: (body: CreatePlanRequest): Promise<AdminPlan> =>
      client.request({ method: 'POST', path: 'admin/plans', body }, AdminPlanSchema),
    update: (id: string, body: UpdatePlanRequest): Promise<AdminPlan> =>
      client.request({ method: 'PATCH', path: path(id), body }, AdminPlanSchema),
    remove: (id: string): Promise<void> => client.request({ method: 'DELETE', path: path(id) }),
  };
}
