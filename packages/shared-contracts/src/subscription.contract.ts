import { SUBSCRIPTION_STATUSES } from '@nexlegtiq/shared-types';
import { z } from 'zod';

/** Feature flags a plan can carry in `Plan.features` (D-005: gating reads flags, never plan codes). */
export const PLAN_FEATURES = ['ai', 'clientPortal', 'googleVisionOcr'] as const;
export type PlanFeature = (typeof PLAN_FEATURES)[number];

/**
 * A flag a plan's `features` does not set (D-122). AI and the client portal are MVP features of every plan (D-002); the
 * paid Google Vision OCR fallback must be switched on per plan. Shared so the admin form shows what a plan really grants.
 */
export const PLAN_FEATURE_DEFAULTS: Readonly<Record<PlanFeature, boolean>> = {
  ai: true,
  clientPortal: true,
  googleVisionOcr: false,
};

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
  /** Limits and usage only for `manage:subscription` holders; `null` for everyone else. */
  limits: z
    .object({ users: count.nullable(), storageMb: count, aiMonthly: count.nullable() })
    .nullable(),
  features: z.object({ ai: z.boolean(), clientPortal: z.boolean(), googleVisionOcr: z.boolean() }),
  /** `aiResetsAt`: when the AI count starts again — the office's next month, in its time zone (D-144). */
  usage: z
    .object({ users: count, storageMb: count, aiThisMonth: count, aiResetsAt: z.iso.datetime() })
    .nullable(),
});
export type OfficeSubscription = z.infer<typeof OfficeSubscriptionSchema>;
