/** Subscription status (D-005, D-006). Mirrors the Prisma enum; labels: `enums.subscriptionStatus.<VALUE>`. */
export const SUBSCRIPTION_STATUSES = [
  'TRIALING',
  'ACTIVE',
  'PAST_DUE',
  'CANCELLED',
  'EXPIRED',
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/** Which market a plan is sold in (D-005): one plan row per market. Mirrors the Prisma enum `PlanMarket`. */
export const PLAN_MARKETS = ['PALESTINE', 'GLOBAL'] as const;
export type PlanMarket = (typeof PLAN_MARKETS)[number];
