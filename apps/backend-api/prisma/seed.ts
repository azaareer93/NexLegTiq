import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../src/generated/prisma/client';
import type { Prisma } from '../src/generated/prisma/client';

type PlanSeed = Omit<Prisma.PlanCreateInput, 'subscriptions'>;

/**
 * Reference plans (D-005, D-006; product.md#pricing). Prices in USD. Storage quotas and the global AI quotas are not
 * in the specs: provisional values, editable in the admin panel — the seed never overwrites an existing plan.
 */
export const PLANS: readonly PlanSeed[] = [
  { code: 'PS_FREE', name: 'Free', market: 'PALESTINE', priceMonthly: '0', currency: 'USD', maxUsers: 5, aiQuotaMonthly: 5, storageQuotaMb: 2_048, trialDays: 180, sortOrder: 10 },
  { code: 'PS_STARTER', name: 'Starter', market: 'PALESTINE', priceMonthly: '29', currency: 'USD', maxUsers: 5, aiQuotaMonthly: 50, storageQuotaMb: 10_240, sortOrder: 20 },
  { code: 'PS_PROFESSIONAL', name: 'Professional', market: 'PALESTINE', priceMonthly: '69', currency: 'USD', maxUsers: 10, aiQuotaMonthly: null, storageQuotaMb: 51_200, sortOrder: 30 },
  { code: 'PS_ENTERPRISE', name: 'Enterprise', market: 'PALESTINE', priceMonthly: '129', currency: 'USD', maxUsers: null, aiQuotaMonthly: null, storageQuotaMb: 204_800, sortOrder: 40 },
  { code: 'GLOBAL_SOLO', name: 'Solo', market: 'GLOBAL', priceMonthly: '49', currency: 'USD', maxUsers: 1, aiQuotaMonthly: 50, storageQuotaMb: 10_240, trialDays: 30, sortOrder: 110 },
  { code: 'GLOBAL_SMALL_FIRM', name: 'Small Firm', market: 'GLOBAL', priceMonthly: '99', currency: 'USD', maxUsers: 3, aiQuotaMonthly: 150, storageQuotaMb: 25_600, trialDays: 30, sortOrder: 120 },
  { code: 'GLOBAL_PROFESSIONAL', name: 'Professional', market: 'GLOBAL', priceMonthly: '199', currency: 'USD', maxUsers: 10, aiQuotaMonthly: null, storageQuotaMb: 102_400, trialDays: 30, sortOrder: 130 },
  // Custom-priced: the admin panel records the negotiated price on the subscription.
  { code: 'GLOBAL_ENTERPRISE', name: 'Enterprise', market: 'GLOBAL', priceMonthly: '0', currency: 'USD', maxUsers: null, aiQuotaMonthly: null, storageQuotaMb: 512_000, features: { customPricing: true }, sortOrder: 140 },
];

/** Idempotent: creates missing plans by code and leaves existing ones untouched (the admin panel owns edits). */
export async function seedPlans(prisma: PrismaClient): Promise<void> {
  for (const plan of PLANS) {
    await prisma.plan.upsert({ where: { code: plan.code }, create: plan, update: {} });
  }
}

export function createSeedClient(): PrismaClient {
  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString) throw new Error('DATABASE_URL is not set (copy .env.example to .env)');
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

async function main(): Promise<void> {
  const prisma = createSeedClient();
  try {
    await seedPlans(prisma);
    console.info(`Seeded ${PLANS.length} plans`);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
