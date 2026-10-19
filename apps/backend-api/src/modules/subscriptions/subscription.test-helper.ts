/**
 * Nested create for `office.create({ data: { subscriptions: liveSubscription() } })`: an ACTIVE subscription without an
 * end on the unlimited plan, so a test office is not read-only (D-122). Integration tests run in band, so
 * `connectOrCreate` cannot race. The plan data mirrors GLOBAL_ENTERPRISE in `prisma/seed.ts`, which this file (compiled
 * with the app) cannot import; an existing row is connected, never changed.
 */
export function liveSubscription() {
  return {
    create: {
      status: 'ACTIVE' as const,
      currentPeriodStart: new Date(),
      plan: {
        connectOrCreate: {
          where: { code: 'GLOBAL_ENTERPRISE' },
          create: {
            code: 'GLOBAL_ENTERPRISE',
            name: 'Enterprise',
            market: 'GLOBAL' as const,
            priceMonthly: '0',
            currency: 'USD',
            maxUsers: null,
            aiQuotaMonthly: null,
            storageQuotaMb: 512_000,
            features: { customPricing: true },
            sortOrder: 140,
          },
        },
      },
    },
  };
}
