import { SUBSCRIPTION_STATUSES } from '@nexlegtiq/shared-types';
import { z } from 'zod';

/** Feature flags a plan can carry in `Plan.features` (D-005: gating reads flags, never plan codes). */
export const PLAN_FEATURES = ['ai', 'clientPortal', 'googleVisionOcr'] as const;
export type PlanFeature = (typeof PLAN_FEATURES)[number];

const count = z.number().int().nonnegative();

/**
 * `GET /offices/me/subscription` (D-122). `status` is the effective one: a trial or period that has ended reads
 * `EXPIRED` even before anyone updates the row, and then `readOnly` is true (writes get 403 AUTH-104). A `null` limit
 * is unlimited.
 */
export const OfficeSubscriptionSchema = z.object({
  /** `null` only for an office without any subscription (never after signup). */
  plan: z.object({ code: z.string(), name: z.string() }).nullable(),
  status: z.enum(SUBSCRIPTION_STATUSES),
  readOnly: z.boolean(),
  periodEnd: z.iso.datetime().nullable(),
  trialEndsAt: z.iso.datetime().nullable(),
  limits: z.object({ users: count.nullable(), storageMb: count, aiMonthly: count.nullable() }),
  features: z.object({ ai: z.boolean(), clientPortal: z.boolean(), googleVisionOcr: z.boolean() }),
  usage: z.object({ users: count, storageMb: count, aiThisMonth: count }),
});
export type OfficeSubscription = z.infer<typeof OfficeSubscriptionSchema>;
