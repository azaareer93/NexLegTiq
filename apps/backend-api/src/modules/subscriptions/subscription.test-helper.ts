import { PLANS } from '../../../prisma/seed';

const UNLIMITED = PLANS.find((plan) => plan.code === 'GLOBAL_ENTERPRISE');

/**
 * Nested create for `office.create({ data: { subscriptions: liveSubscription() } })`: an ACTIVE subscription without an
 * end on the unlimited plan, so a test office is not read-only (D-122). Integration tests run in band, so
 * `connectOrCreate` cannot race.
 */
export function liveSubscription() {
  if (!UNLIMITED) throw new Error('GLOBAL_ENTERPRISE plan missing from the seed');
  return {
    create: {
      status: 'ACTIVE' as const,
      currentPeriodStart: new Date(),
      plan: { connectOrCreate: { where: { code: UNLIMITED.code }, create: UNLIMITED } },
    },
  };
}
