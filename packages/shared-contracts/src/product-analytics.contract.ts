import { ONBOARDING_STEPS } from '@nexlegtiq/shared-types';
import { z } from 'zod';

const NoProps = z.strictObject({});
const only = <E extends string>(event: E) =>
  z.strictObject({ event: z.literal(event), props: NoProps });

/**
 * One product analytics event and its props (D-215). An allow-list: every event lists its props, and a key not listed is
 * refused (strict objects), so no name, email, case title or document content can ride along. The office id is the
 * only identifier, and the backend adds it.
 */
export const ProductEventSchema = z.discriminatedUnion('event', [
  only('SIGNUP_COMPLETED'),
  z.strictObject({
    event: z.literal('ONBOARDING_STEP_COMPLETED'),
    props: z.strictObject({ step: z.enum(ONBOARDING_STEPS) }),
  }),
  only('ONBOARDING_COMPLETED'),
  z.strictObject({
    event: z.literal('FIRST_CASE_CREATED'),
    props: z.strictObject({ secondsSinceSignup: z.number().int().min(0) }),
  }),
  only('HEARING_SCHEDULED'),
  only('DOCUMENT_UPLOADED'),
  only('AI_SUMMARY_GENERATED'),
  only('INVITE_SENT'),
  only('PORTAL_INVITE_SENT'),
  only('APP_ACTIVE'),
]);
export type ProductEvent = z.infer<typeof ProductEventSchema>;
export type ProductEventProps<E extends ProductEvent['event']> = Extract<
  ProductEvent,
  { event: E }
>['props'];

/** The funnel's steps, in order (D-215): each counts the offices of the period's signups that reached it. */
export const FUNNEL_EVENTS = [
  'SIGNUP_COMPLETED',
  'ONBOARDING_COMPLETED',
  'FIRST_CASE_CREATED',
  'HEARING_SCHEDULED',
  'DOCUMENT_UPLOADED',
  'AI_SUMMARY_GENERATED',
  'INVITE_SENT',
  'PORTAL_INVITE_SENT',
] as const satisfies readonly ProductEvent['event'][];

/** `GET /admin/analytics?days` (D-215): offices that signed up in the last 7 to 365 days, 90 by default. */
export const AdminAnalyticsQuerySchema = z.object({
  days: z.coerce.number().int().min(7).max(365).default(90),
});
export type AdminAnalyticsQuery = z.infer<typeof AdminAnalyticsQuerySchema>;

/** Offices whose retention window has ended, and how many of them were active in it. */
const CohortSchema = z.object({ offices: z.number().int(), retained: z.number().int() });

/** Onboarding funnel and retention of the offices that signed up in the period (D-215): counts only. */
export const AdminAnalyticsSchema = z.object({
  since: z.iso.date(),
  funnel: z.array(z.object({ event: z.enum(FUNNEL_EVENTS), offices: z.number().int() })),
  onboardingSteps: z.array(z.object({ step: z.enum(ONBOARDING_STEPS), offices: z.number().int() })),
  medianSecondsToFirstCase: z.number().int().nullable(),
  /** D7 = active on days 7–13 after signup, D30 = days 30–36. */
  retention: z.object({ d7: CohortSchema, d30: CohortSchema }),
});
export type AdminAnalytics = z.infer<typeof AdminAnalyticsSchema>;
