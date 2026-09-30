import { createSeedClient, PLANS, seedPlans } from '../../prisma/seed';
import { DEMO_OFFICE_ID, seedDemo } from '../../prisma/seed-demo';
import type { PrismaClient } from '../generated/prisma/client';

/** Runs `body` in a transaction that is always rolled back, so tests leave no rows behind. */
async function inRollback(prisma: PrismaClient, body: (tx: PrismaClient) => Promise<void>): Promise<void> {
  const rollback = new Error('rollback');
  await expect(
    prisma.$transaction(async (tx) => {
      await body(tx as unknown as PrismaClient);
      throw rollback;
    }),
  ).rejects.toBe(rollback);
}

describe('database (migrations + seeds, real PostgreSQL)', () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = createSeedClient();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('should seed plans idempotently', async () => {
    await seedPlans(prisma);
    const first = await prisma.plan.findMany({ select: { id: true, code: true }, orderBy: { code: 'asc' } });
    await seedPlans(prisma);
    const second = await prisma.plan.findMany({ select: { id: true, code: true }, orderBy: { code: 'asc' } });

    expect(first.map((plan) => plan.code)).toEqual(expect.arrayContaining(PLANS.map((plan) => plan.code)));
    expect(second).toEqual(first);
  });

  it('should seed the demo office idempotently with one live subscription', async () => {
    await seedDemo(prisma);
    await seedDemo(prisma);

    const office = await prisma.office.findUniqueOrThrow({ where: { id: DEMO_OFFICE_ID }, include: { settings: true } });
    expect(office.settings).toMatchObject({ courtReminderDays: [7, 3, 1], auditRetentionDays: 365 });
    await expect(prisma.user.count({ where: { officeId: DEMO_OFFICE_ID } })).resolves.toBe(1);
    await expect(
      prisma.subscription.count({ where: { officeId: DEMO_OFFICE_ID, status: { in: ['TRIALING', 'ACTIVE'] } } }),
    ).resolves.toBe(1);
  });

  it.each([
    ['مُحَمَّد', 'محمد'], // tashkeel
    ['محـــمد', 'محمد'], // tatweel
    ['أحمد إبراهيم آمال ٱلقدس', 'احمد ابراهيم امال القدس'], // alef variants
    ['مستشفى', 'مستشفي'], // alef maqsura
    ['محكمة', 'محكمه'], // ta marbuta
    ['Court OF Appeal', 'court of appeal'],
  ])('should normalise %s to %s with nlq_normalize_ar', async (input, expected) => {
    const [row] = await prisma.$queryRaw<[{ value: string }]>`SELECT nlq_normalize_ar(${input}) AS value`;

    expect(row.value).toBe(expected);
  });

  it('should allow only one TRIALING/ACTIVE subscription per office', async () => {
    await seedPlans(prisma);
    await inRollback(prisma, async (tx) => {
      const office = await tx.office.create({ data: { name: 'Isolation test office' } });
      const plan = await tx.plan.findUniqueOrThrow({ where: { code: 'PS_FREE' } });
      const base = { officeId: office.id, planId: plan.id, currentPeriodStart: new Date() };

      await tx.subscription.create({ data: { ...base, status: 'CANCELLED' } });
      await tx.subscription.create({ data: { ...base, status: 'TRIALING' } });
      await expect(tx.subscription.create({ data: { ...base, status: 'ACTIVE' } })).rejects.toMatchObject({
        code: 'P2002',
      });
    });
  });

  it('should reject audit retention below 365 days and idle timeouts outside 15–120 minutes', async () => {
    await inRollback(prisma, async (tx) => {
      const office = await tx.office.create({ data: { name: 'Settings test office' } });

      await expect(
        tx.officeSettings.create({ data: { officeId: office.id, auditRetentionDays: 30 } }),
      ).rejects.toThrow(/audit_retention_days/);
    });
    await inRollback(prisma, async (tx) => {
      const office = await tx.office.create({ data: { name: 'Settings test office' } });

      await expect(
        tx.officeSettings.create({ data: { officeId: office.id, sessionIdleMinutes: 5 } }),
      ).rejects.toThrow(/session_idle_minutes/);
    });
  });

  it('should treat user emails as case-insensitively unique across offices (D-032)', async () => {
    await inRollback(prisma, async (tx) => {
      // Sequential: one transaction is one connection.
      const a = await tx.office.create({ data: { name: 'Office A' } });
      const b = await tx.office.create({ data: { name: 'Office B' } });
      const user = { fullName: 'Lawyer', passwordHash: '!', role: 'LAWYER' } as const;

      await tx.user.create({ data: { ...user, officeId: a.id, email: 'Lawyer@Example.test' } });
      await expect(
        tx.user.create({ data: { ...user, officeId: b.id, email: 'lawyer@example.TEST' } }),
      ).rejects.toMatchObject({ code: 'P2002' });
    });
  });
});
