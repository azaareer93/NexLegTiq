import type { OfficeId } from '@nexlegtiq/shared-types';
import { ClsServiceManager } from 'nestjs-cls';
import type { PinoLogger } from 'nestjs-pino';

import { PrismaService } from './prisma.service';
import { TENANT_ISOLATION_MATRIX } from './tenant-isolation.matrix';
import type { SeededOffice, TenantResource } from './tenant-isolation.matrix';
import { TENANT_MODELS } from './tenant-models';
import type { RequestContext } from '../common/context/request-context';
import { TenantRunner } from '../common/tenancy/tenant-runner';
import { TenantContextMissingError, TenantViolationError } from '../common/tenancy/tenant.errors';
import { AppConfig } from '../config/app-config';
import { testEnv } from '../config/env.fixture';
import { parseEnv } from '../config/env.schema';
import { ReadinessRegistry } from '../health/readiness.registry';

type Delegate = Record<string, (args?: unknown) => Promise<unknown>>;
const delegate = (client: object, model: string): Delegate =>
  (client as Record<string, Delegate>)[model.charAt(0).toLowerCase() + model.slice(1)] as Delegate;

/**
 * D-018/D-019 on real PostgreSQL with two offices: through the scoped client, office A sees and changes only its own rows
 * for every tenant model, and office B's rows behave as if they did not exist (not found / zero rows).
 */
describe('tenant isolation (two offices, scoped Prisma client)', () => {
  const cls = ClsServiceManager.getClsService<RequestContext>();
  const runner = new TenantRunner(cls);
  let prisma: PrismaService;
  let a: SeededOffice;
  let b: SeededOffice;

  const asOffice = <T>(office: SeededOffice, work: () => Promise<T>): Promise<T> =>
    runner.run({ officeId: office.officeId as OfficeId }, work);

  async function seedOffice(name: string): Promise<SeededOffice> {
    const raw = prisma.unscoped();
    const office = await raw.office.create({ data: { name } });
    const user = await raw.user.create({
      data: {
        officeId: office.id,
        fullName: 'Seed',
        email: `seed-${office.id}@example.test`,
        passwordHash: '!',
        role: 'OFFICE_MANAGER',
      },
    });
    const plan = await raw.plan.upsert({
      where: { code: 'ISOLATION_TEST' },
      create: {
        code: 'ISOLATION_TEST',
        name: 'Isolation test',
        market: 'GLOBAL',
        priceMonthly: '0',
        currency: 'USD',
        storageQuotaMb: 1,
      },
      update: {},
    });
    return { officeId: office.id, userId: user.id, planId: plan.id };
  }

  beforeAll(async () => {
    // Real DATABASE_URL from the environment (jest.integration.config.cjs has no env fixture).
    const config = new AppConfig(
      parseEnv(testEnv({ DATABASE_URL: process.env['DATABASE_URL'], NODE_ENV: 'test' })),
    );
    prisma = new PrismaService(
      config,
      new ReadinessRegistry({ setContext: () => undefined } as unknown as PinoLogger),
      cls,
    );
    a = await seedOffice('Isolation office A');
    b = await seedOffice('Isolation office B');
  });

  afterAll(async () => {
    if (!prisma) return;
    const raw = prisma.unscoped();
    // Tolerates a beforeAll that failed half-way: only offices that were created are cleaned up.
    const ids = [a?.officeId, b?.officeId].filter((id): id is string => id !== undefined);
    const offices = { officeId: { in: ids } };
    // Children first. Needs the test superuser: the app role cannot delete audit rows (D-079).
    for (const model of [...TENANT_MODELS].filter((m) => m !== 'User').reverse()) {
      await delegate(raw, model)['deleteMany']?.({ where: offices });
    }
    await raw.user.deleteMany({ where: offices });
    await raw.office.deleteMany({ where: { id: { in: ids } } });
    await raw.plan.deleteMany({ where: { code: 'ISOLATION_TEST', subscriptions: { none: {} } } });
    await prisma.onModuleDestroy();
  });

  it('should cover every tenant model', () => {
    expect(TENANT_ISOLATION_MATRIX.map((resource) => resource.model).sort()).toEqual(
      [...TENANT_MODELS].sort(),
    );
  });

  describe.each(TENANT_ISOLATION_MATRIX.map((resource) => [resource.model, resource] as const))(
    '%s',
    (model, resource: TenantResource) => {
      let own: { id: string };
      let foreign: { id: string };

      beforeAll(async () => {
        own = await resource.create(prisma.unscoped(), a);
        foreign = await resource.create(prisma.unscoped(), b);
      });

      it('should list and count only the current office rows', () =>
        asOffice(a, async () => {
          const db = delegate(prisma.db, model);
          const ids = { id: { in: [own.id, foreign.id] } };

          await expect(db['findMany']?.({ where: ids, select: { id: true } })).resolves.toEqual([
            { id: own.id },
          ]);
          await expect(db['count']?.({ where: ids })).resolves.toBe(1);
        }));

      it('should not find, update or delete another office row', () =>
        asOffice(a, async () => {
          const db = delegate(prisma.db, model);
          const where = { id: foreign.id };

          await expect(db['findUnique']?.({ where })).resolves.toBeNull();
          await expect(db['findFirst']?.({ where })).resolves.toBeNull();
          await expect(db['update']?.({ where, data: resource.update })).rejects.toMatchObject({
            code: 'P2025',
          });
          await expect(db['updateMany']?.({ where, data: resource.update })).resolves.toEqual({
            count: 0,
          });
          await expect(db['delete']?.({ where })).rejects.toMatchObject({ code: 'P2025' });
          await expect(db['deleteMany']?.({ where })).resolves.toEqual({ count: 0 });
          await expect(db['groupBy']?.({ by: ['id'], where })).resolves.toEqual([]);
          await expect(db['aggregate']?.({ where, _count: { _all: true } })).resolves.toMatchObject(
            { _count: { _all: 0 } },
          );
        }));

      it('should still reach its own row', () =>
        asOffice(a, async () => {
          await expect(
            delegate(prisma.db, model)['findUnique']?.({ where: { id: own.id } }),
          ).resolves.toMatchObject({ id: own.id });
        }));

      it('should refuse to run without an office in context', async () => {
        await expect(delegate(prisma.db, model)['findMany']?.()).rejects.toThrow(
          TenantContextMissingError,
        );
      });
    },
  );

  it('should inject the current office on create and reject a foreign one', () =>
    asOffice(a, async () => {
      const created = await prisma.db.notification.create({
        data: { userId: a.userId, type: 'TEST', titleKey: 'test.title' } as never,
      });
      expect(created.officeId).toBe(a.officeId);
      await expect(
        prisma.db.notification.create({
          data: { officeId: b.officeId, userId: b.userId, type: 'TEST', titleKey: 't' },
        }),
      ).rejects.toThrow(TenantViolationError);
    }));

  it('should reject nested writes into tenant models', () =>
    asOffice(a, async () => {
      await expect(
        prisma.db.user.update({
          where: { id: a.userId },
          data: {
            notifications: { create: { officeId: a.officeId, type: 'TEST', titleKey: 't' } },
          } as never,
        }),
      ).rejects.toThrow(TenantViolationError);
    }));

  it('should limit Office to the current office and scope tenant lists and filters reached from a global model', async () => {
    const raw = prisma.unscoped();
    const note = `probe-${b.officeId}`;
    for (const office of [a, b]) {
      await raw.subscription.create({
        data: {
          officeId: office.officeId,
          planId: office.planId,
          status: 'CANCELLED',
          currentPeriodStart: new Date(),
          notes: note,
        },
      });
    }

    await asOffice(a, async () => {
      await expect(prisma.db.office.findMany({ select: { id: true } })).resolves.toEqual([
        { id: a.officeId },
      ]);
      const plan = await prisma.db.plan.findUniqueOrThrow({
        where: { id: a.planId },
        include: { subscriptions: true },
      });
      expect(plan.subscriptions.length).toBeGreaterThan(0);
      expect(plan.subscriptions.every((subscription) => subscription.officeId === a.officeId)).toBe(
        true,
      );
      // Office B's notes must not be observable through a relation filter on the shared plan.
      await expect(
        prisma.db.plan.count({
          where: { subscriptions: { some: { notes: note, officeId: undefined } } },
        } as never),
      ).rejects.toThrow(TenantViolationError);
      await raw.subscription.updateMany({
        where: { officeId: a.officeId, notes: note },
        data: { notes: 'mine' },
      });
      await expect(
        prisma.db.plan.count({ where: { subscriptions: { some: { notes: note } } } }),
      ).resolves.toBe(0);
    });
  });

  it('should keep global models read-only on the scoped client', () =>
    asOffice(a, async () => {
      await expect(prisma.db.loginAttempt.deleteMany()).rejects.toThrow(TenantViolationError);
      await expect(
        prisma.db.plan.update({ where: { id: a.planId }, data: { priceMonthly: '0' } }),
      ).rejects.toThrow(TenantViolationError);
    }));

  it('should let the composite FKs reject rows that point at another office', () =>
    asOffice(a, async () => {
      // Scalar FKs pass the extension; the database refuses a user or rotated token of office B (D-079, D-080).
      await expect(
        prisma.db.notification.create({
          data: { userId: b.userId, type: 'TEST', titleKey: 't' } as never,
        }),
      ).rejects.toMatchObject({ code: 'P2003' });
      const mine = await prisma.db.refreshToken.create({
        data: {
          userId: a.userId,
          familyId: a.userId,
          tokenHash: `own-${a.officeId}`,
          expiresAt: new Date(Date.now() + 60_000),
        } as never,
      });
      const theirs = await prisma.unscoped().refreshToken.create({
        data: {
          officeId: b.officeId,
          userId: b.userId,
          familyId: b.userId,
          tokenHash: `their-${b.officeId}`,
          expiresAt: new Date(),
        },
      });
      await expect(
        prisma.db.refreshToken.update({
          where: { id: mine.id },
          data: { replacedById: theirs.id },
        }),
      ).rejects.toMatchObject({ code: 'P2003' });
    }));

  it('should keep the scope inside interactive transactions', () =>
    asOffice(a, async () => {
      const offices = await prisma.db.$transaction(async (tx) =>
        (await tx.user.findMany({ select: { officeId: true } })).map((user) => user.officeId),
      );
      expect(offices.length).toBeGreaterThan(0);
      expect(new Set(offices)).toEqual(new Set([a.officeId]));
      await expect(
        prisma.unscoped().user.count({ where: { officeId: b.officeId } }),
      ).resolves.toBeGreaterThan(0);
    }));

  it('should only allow raw SQL on tenant tables with the current officeId as a parameter', () =>
    asOffice(a, async () => {
      await expect(prisma.db.$queryRaw`SELECT count(*)::int AS n FROM users`).rejects.toThrow(
        TenantViolationError,
      );
      await expect(
        prisma.db.$queryRaw<
          [{ n: number }]
        >`SELECT count(*)::int AS n FROM users WHERE office_id = ${a.officeId}::uuid`,
      ).resolves.toEqual([{ n: expect.any(Number) }]);
      await expect(prisma.db.$queryRaw`SELECT nlq_normalize_ar(${'محكمة'}) AS v`).resolves.toEqual([
        { v: 'محكمه' },
      ]);
    }));
});
