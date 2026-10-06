import type { PrismaClient } from '../src/generated/prisma/client';
import { createSeedClient, seedPlans } from './seed';

/** Fixed ids so re-running updates the same rows instead of creating new ones. */
export const DEMO_OFFICE_ID = '01920000-0000-7000-8000-000000000001';
export const DEMO_MANAGER_EMAIL = 'manager@demo.nexlegtiq.test';

/**
 * Demo data for local development and tests only (NODE_ENV=development|test). The manager's password hash is a
 * placeholder that matches no password: the auth story chooses the hashing algorithm and a way to set it.
 */
export async function seedDemo(prisma: PrismaClient): Promise<void> {
  await seedPlans(prisma);
  const office = {
    name: 'مكتب المحاماة التجريبي',
    jurisdiction: 'PALESTINE',
    currency: 'ILS',
  } as const;
  await prisma.office.upsert({
    where: { id: DEMO_OFFICE_ID },
    create: { id: DEMO_OFFICE_ID, ...office, settings: { create: {} } },
    update: office,
  });
  await prisma.user.upsert({
    where: { email: DEMO_MANAGER_EMAIL },
    create: {
      officeId: DEMO_OFFICE_ID,
      fullName: 'مدير المكتب التجريبي',
      email: DEMO_MANAGER_EMAIL,
      passwordHash: '!',
      role: 'OFFICE_MANAGER',
      emailVerifiedAt: new Date(),
    },
    update: {},
  });
  const live = await prisma.subscription.findFirst({
    where: { officeId: DEMO_OFFICE_ID, status: { in: ['TRIALING', 'ACTIVE'] } },
  });
  if (!live) {
    const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'PS_FREE' } });
    const now = new Date();
    await prisma.subscription.create({
      data: {
        officeId: DEMO_OFFICE_ID,
        planId: plan.id,
        status: 'TRIALING',
        currentPeriodStart: now,
        trialEndsAt: new Date(now.getTime() + (plan.trialDays ?? 0) * 86_400_000),
      },
    });
  }
}

async function main(): Promise<void> {
  // Fail closed: an unset NODE_ENV means production (env.schema.ts), so only explicit dev/test may seed demo data.
  const nodeEnv = process.env['NODE_ENV'];
  if (nodeEnv !== 'development' && nodeEnv !== 'test')
    throw new Error('seed-demo runs only with NODE_ENV=development or test');
  const prisma = createSeedClient();
  try {
    await seedDemo(prisma);
    console.info('Seeded demo office');
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
