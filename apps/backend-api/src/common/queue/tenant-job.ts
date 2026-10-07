import type { OfficeId } from '@nexlegtiq/shared-types';
import { z } from 'zod';

import { SAFE_REQUEST_ID } from '../context/request-context';

/** Every job payload carries the office it runs for and the request that enqueued it (tenant-isolation skill, D-076). */
export interface TenantJobData {
  readonly officeId: OfficeId;
  /** Correlation only (D-076); null when a payload's id is missing or malformed. */
  readonly requestId: string | null;
}

/**
 * Job-specific fields (interfaces welcome): the producer adds `officeId`/`requestId` from the request context, callers
 * never pass them. Payloads go through JSON in Redis, so use ids, strings and numbers — not Dates, Maps or Decimals.
 */
export type JobFields = object & { readonly officeId?: never; readonly requestId?: never };

const TenantJobSchema = z.object({ officeId: z.uuid(), requestId: z.string().nullable() });

/**
 * Validates the tenant part of a payload read back from Redis; null when the office is missing or malformed. A request id
 * that is not D-076-safe is dropped (a new one is generated for the job's logs), never trusted.
 */
export function parseTenantJob(data: unknown): TenantJobData | null {
  const result = TenantJobSchema.safeParse(data);
  if (!result.success) return null;
  const { officeId, requestId } = result.data;
  return {
    officeId: officeId as OfficeId,
    requestId: requestId !== null && SAFE_REQUEST_ID.test(requestId) ? requestId : null,
  };
}
