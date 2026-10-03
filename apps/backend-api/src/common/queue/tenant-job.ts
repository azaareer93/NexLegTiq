import type { OfficeId } from '@nexlegtiq/shared-types';
import { z } from 'zod';

/** Every job payload carries the office it runs for and the request that enqueued it (tenant-isolation skill, D-076). */
export interface TenantJobData {
  readonly officeId: OfficeId;
  /** Correlation only (D-076); null for jobs not started by a request (schedulers). */
  readonly requestId: string | null;
}

/** Job-specific fields: the producer adds `officeId`/`requestId` from the request context, callers never pass them. */
export type JobFields = Record<string, unknown> & { readonly officeId?: never; readonly requestId?: never };

const TenantJobSchema = z.object({ officeId: z.uuid(), requestId: z.string().max(128).nullable() });

/** Validates the tenant part of a payload read back from Redis; null when it is missing or malformed. */
export function parseTenantJob(data: unknown): TenantJobData | null {
  const result = TenantJobSchema.safeParse(data);
  return result.success ? { officeId: result.data.officeId as OfficeId, requestId: result.data.requestId } : null;
}
