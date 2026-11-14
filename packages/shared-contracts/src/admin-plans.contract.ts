import { PLAN_MARKETS } from '@nexlegtiq/shared-types';
import { z } from 'zod';

import { longText, MoneySchema, plainText } from './fields.js';

const count = z.number().int().nonnegative().max(1_000_000_000);

/**
 * Flags the plan sets (`PLAN_FEATURES` gate the app; a flag left out takes its default, D-122). Other flags, such as the
 * seeded `customPricing`, are kept as given: they are labels for the sales side, never read by the gating code.
 */
const FeaturesSchema = z
  .record(z.string().regex(/^[a-z][A-Za-z0-9]{0,39}$/, 'validation.invalidCharacters'), z.boolean())
  .refine((flags) => Object.keys(flags).length <= 20, 'validation.tooLong');

/** What a platform admin edits on a plan (D-005, D-173). `null` limits are unlimited. */
const PlanFields = {
  name: plainText(100).min(1, 'validation.required'),
  market: z.enum(PLAN_MARKETS),
  priceMonthly: MoneySchema,
  currency: z
    .string()
    .trim()
    .regex(/^[A-Z]{3}$/, 'validation.currency'),
  maxUsers: count.min(1).nullable(),
  aiQuotaMonthly: count.nullable(),
  ocrPagesMonthly: count,
  storageQuotaMb: count.min(1),
  /** Trial length offered at signup for plans that start in TRIALING (D-006); null = none. */
  trialDays: z.number().int().min(1).max(3650).nullable(),
  features: FeaturesSchema,
  isActive: z.boolean(),
  sortOrder: z.number().int().min(0).max(10_000),
};

/** `POST /admin/plans`. The code is fixed once created: signup and seeds find plans by code. */
export const CreatePlanSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^[A-Z][A-Z0-9_]{1,63}$/, 'validation.planCode'),
  ...PlanFields,
  ocrPagesMonthly: PlanFields.ocrPagesMonthly.default(0),
  trialDays: PlanFields.trialDays.default(null),
  features: PlanFields.features.default({}),
  isActive: PlanFields.isActive.default(true),
  sortOrder: PlanFields.sortOrder.default(0),
});
export type CreatePlanRequest = z.infer<typeof CreatePlanSchema>;

/** `PATCH /admin/plans/:id`: any field but the code. */
export const UpdatePlanSchema = z
  .object(PlanFields)
  .partial()
  .refine((body) => Object.keys(body).length > 0, 'validation.required');
export type UpdatePlanRequest = z.infer<typeof UpdatePlanSchema>;

export const AdminPlanSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  ...PlanFields,
  name: z.string(),
  priceMonthly: z.string(),
  currency: z.string(),
  features: z.record(z.string(), z.boolean()),
  /** Subscriptions (of any status) on this plan; a plan in use cannot be deleted (BIZ-022). */
  subscriptionCount: z.number().int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type AdminPlan = z.infer<typeof AdminPlanSchema>;

/** A date the subscription runs until, inclusive, in the office's time zone. */
const Until = z.iso.date('validation.date');

/**
 * `POST /admin/offices/:id/subscription` (D-173): one action on the office's current subscription. Payments are recorded
 * apart and never change the subscription (owner, 2026-11-14).
 */
export const SubscriptionActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('CHANGE_PLAN'),
    planId: z.uuid(),
    reason: longText(500).optional(),
  }),
  z.object({ action: z.literal('EXTEND_PERIOD'), until: Until, reason: longText(500).optional() }),
  z.object({ action: z.literal('SET_TRIAL'), until: Until, reason: longText(500).optional() }),
]);
export type SubscriptionActionRequest = z.infer<typeof SubscriptionActionSchema>;
export const SUBSCRIPTION_ACTIONS = ['CHANGE_PLAN', 'EXTEND_PERIOD', 'SET_TRIAL'] as const;
