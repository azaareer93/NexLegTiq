/** Subscription status (D-005, D-006). Mirrors the Prisma enum; labels: `enums.subscriptionStatus.<VALUE>`. */
export const SUBSCRIPTION_STATUSES = [
  'TRIALING',
  'ACTIVE',
  'PAST_DUE',
  'CANCELLED',
  'EXPIRED',
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];
