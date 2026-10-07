import { normalizeArabic } from '@nexlegtiq/shared-utils';

import { createSeedClient, PLANS, seedPlans } from '../../prisma/seed';
import { DEMO_OFFICE_ID, seedDemo } from '../../prisma/seed-demo';
import type { PrismaClient } from '../generated/prisma/client';

/** Runs `body` in a transaction that is always rolled back, so tests leave no rows behind. */
async function inRollback(
  prisma: PrismaClient,
  body: (tx: PrismaClient) => Promise<void>,
): Promise<void> {
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
    const first = await prisma.plan.findMany({
      select: { id: true, code: true },
      orderBy: { code: 'asc' },
    });
    await seedPlans(prisma);
    const second = await prisma.plan.findMany({
      select: { id: true, code: true },
      orderBy: { code: 'asc' },
    });

    expect(first.map((plan) => plan.code)).toEqual(
      expect.arrayContaining(PLANS.map((plan) => plan.code)),
    );
    expect(second).toEqual(first);
  });

  it('should never overwrite a plan edited after seeding (the admin panel owns edits)', async () => {
    await seedPlans(prisma);
    await inRollback(prisma, async (tx) => {
      await tx.plan.update({ where: { code: 'PS_STARTER' }, data: { priceMonthly: '31.5' } });
      await seedPlans(tx);

      const plan = await tx.plan.findUniqueOrThrow({ where: { code: 'PS_STARTER' } });
      expect(plan.priceMonthly.toString()).toBe('31.5');
    });
  });

  it('should seed the demo office idempotently with one live subscription', async () => {
    const counts = (): Promise<number[]> =>
      Promise.all([
        prisma.office.count(),
        prisma.officeSettings.count(),
        prisma.user.count(),
        prisma.subscription.count(),
        prisma.plan.count(),
      ]);
    await seedDemo(prisma);
    const afterFirst = await counts();
    await seedDemo(prisma);

    await expect(counts()).resolves.toEqual(afterFirst);

    const office = await prisma.office.findUniqueOrThrow({
      where: { id: DEMO_OFFICE_ID },
      include: { settings: true },
    });
    expect(office.settings).toMatchObject({
      courtReminderDays: [7, 3, 1],
      auditRetentionDays: 365,
    });
    await expect(prisma.user.count({ where: { officeId: DEMO_OFFICE_ID } })).resolves.toBe(1);
    await expect(
      prisma.subscription.count({
        where: { officeId: DEMO_OFFICE_ID, status: { in: ['TRIALING', 'ACTIVE'] } },
      }),
    ).resolves.toBe(1);
  });

  it.each([
    ['مُحَمَّد', 'محمد'], // tashkeel
    ['محـــمد', 'محمد'], // tatweel
    ['أحمد إبراهيم آمال ٱلقدس', 'احمد ابراهيم امال القدس'], // alef variants
    ['مستشفى', 'مستشفي'], // alef maqsura
    ['محكمة', 'محكمه'], // ta marbuta
    ['مسائل مؤجلة', 'مسايل موجله'], // hamza seats ئ ؤ
    ['Court OF Appeal', 'court of appeal'],
    ['محكمة Appeal ١٢٣', 'محكمه appeal ١٢٣'], // mixed script, Arabic-Indic digits untouched
    ['', ''],
  ])('should normalise %s to %s with nlq_normalize_ar', async (input, expected) => {
    const [row] = await prisma.$queryRaw<
      [{ value: string }]
    >`SELECT nlq_normalize_ar(${input}) AS value`;

    expect(row.value).toBe(expected);
    // The app's normalizeArabic (search terms typed in the UI) must agree with the database function (MVP-46).
    expect(normalizeArabic(input)).toBe(row.value);
  });

  it('should return NULL for NULL and be idempotent', async () => {
    const [row] = await prisma.$queryRaw<[{ nulled: string | null; twice: string; once: string }]>`
      SELECT nlq_normalize_ar(NULL) AS nulled,
             nlq_normalize_ar(nlq_normalize_ar('إِبْرَاهِيمُ مُؤَسَّسَة')) AS twice,
             nlq_normalize_ar('إِبْرَاهِيمُ مُؤَسَّسَة') AS once`;

    expect(row.nulled).toBeNull();
    expect(row.twice).toBe(row.once);
  });

  it('should allow only one TRIALING/ACTIVE subscription per office', async () => {
    await seedPlans(prisma);
    await inRollback(prisma, async (tx) => {
      const office = await tx.office.create({ data: { name: 'Isolation test office' } });
      const plan = await tx.plan.findUniqueOrThrow({ where: { code: 'PS_FREE' } });
      const base = { officeId: office.id, planId: plan.id, currentPeriodStart: new Date() };

      await tx.subscription.create({ data: { ...base, status: 'CANCELLED' } });
      await tx.subscription.create({ data: { ...base, status: 'TRIALING' } });
      await expect(
        tx.subscription.create({ data: { ...base, status: 'ACTIVE' } }),
      ).rejects.toMatchObject({
        code: 'P2002',
      });
    });
  });

  it('should scope the live-subscription rule to each office', async () => {
    await seedPlans(prisma);
    await inRollback(prisma, async (tx) => {
      const plan = await tx.plan.findUniqueOrThrow({ where: { code: 'PS_FREE' } });
      const a = await tx.office.create({ data: { name: 'Office A' } });
      const b = await tx.office.create({ data: { name: 'Office B' } });
      const live = { planId: plan.id, status: 'ACTIVE', currentPeriodStart: new Date() } as const;

      await tx.subscription.create({ data: { ...live, officeId: a.id } });
      await expect(
        tx.subscription.create({ data: { ...live, officeId: b.id } }),
      ).resolves.toBeDefined();
    });
  });

  it('should reject a child row whose office differs from the office of its user (composite FK, D-079)', async () => {
    await inRollback(prisma, async (tx) => {
      const a = await tx.office.create({ data: { name: 'Office A' } });
      const b = await tx.office.create({ data: { name: 'Office B' } });
      const user = await tx.user.create({
        data: {
          officeId: a.id,
          fullName: 'Lawyer',
          email: 'fk@example.test',
          passwordHash: '!',
          role: 'LAWYER',
        },
      });

      await expect(
        tx.refreshToken.create({
          data: {
            officeId: b.id,
            userId: user.id,
            familyId: user.id,
            tokenHash: 'hash',
            expiresAt: new Date(Date.now() + 60_000),
          },
        }),
      ).rejects.toThrow();
    });
  });

  it('should keep audit rows when someone tries to delete the acting user (RESTRICT)', async () => {
    await inRollback(prisma, async (tx) => {
      const office = await tx.office.create({ data: { name: 'Audit office' } });
      const user = await tx.user.create({
        data: {
          officeId: office.id,
          fullName: 'Actor',
          email: 'actor@example.test',
          passwordHash: '!',
          role: 'LAWYER',
        },
      });
      await tx.auditLog.create({
        data: { officeId: office.id, userId: user.id, entityType: 'User', action: 'LOGIN' },
      });

      await expect(tx.user.delete({ where: { id: user.id } })).rejects.toThrow();
    });
  });

  it('should reject audit retention below 365 days and idle timeouts outside 15–120 minutes', async () => {
    await inRollback(prisma, async (tx) => {
      const office = await tx.office.create({ data: { name: 'Settings boundary office' } });

      await expect(
        tx.officeSettings.create({
          data: { officeId: office.id, auditRetentionDays: 365, sessionIdleMinutes: 120 },
        }),
      ).resolves.toBeDefined();
    });
    await inRollback(prisma, async (tx) => {
      const office = await tx.office.create({ data: { name: 'Settings test office' } });

      await expect(
        tx.officeSettings.create({ data: { officeId: office.id, auditRetentionDays: 364 } }),
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
