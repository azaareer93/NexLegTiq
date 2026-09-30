import type { OfficeId } from '@nexlegtiq/shared-types';
import { ClsServiceManager } from 'nestjs-cls';
import type { PinoLogger } from 'nestjs-pino';

import type { RequestContext } from '../common/context/request-context';
import { TenantRunner } from '../common/tenancy/tenant-runner';
import { TenantContextMissingError, TenantViolationError } from '../common/tenancy/tenant.errors';
import { AppConfig } from '../config/app-config';
import { testEnv } from '../config/env.fixture';
import { parseEnv } from '../config/env.schema';
import { ReadinessRegistry } from '../health/readiness.registry';
import { PrismaService } from './prisma.service';
import { TENANT_ISOLATION_MATRIX } from './tenant-isolation.matrix';
import type { SeededOffice, TenantResource } from './tenant-isolation.matrix';
import { TENANT_MODELS } from './tenant-models';

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
      data: { officeId: office.id, fullName: 'Seed', email: `seed-${office.id}@example.test`, passwordHash: '!', role: 'OFFICE_MANAGER' },
    });
    const plan = await raw.plan.upsert({
      where: { code: 'ISOLATION_TEST' },
      create: { code: 'ISOLATION_TEST', name: 'Isolation test', market: 'GLOBAL', priceMonthly: '0', currency: 'USD', storageQuotaMb: 1 },
      update: {},
    });
    return { officeId: office.id, userId: user.id, planId: plan.id };
  }

  beforeAll(async () => {
    // Real DATABASE_URL from the environment (jest.integration.config.cjs has no env fixture).
    const config = new AppConfig(parseEnv(testEnv({ DATABASE_URL: process.env['DATABASE_URL'], NODE_ENV: 'test' })));
    prisma = new PrismaService(config, new ReadinessRegistry({ setContext: () => undefined } as unknown as PinoLogger), cls);
    a = await seedOffice('Isolation office A');
    b = await seedOffice('Isolation office B');
  });

  afterAll(async () => {
    const raw = prisma.unscoped();
    const offices = { officeId: { in: [a.officeId, b.officeId] } };
    // Children first; audit rows are append-only for the app role only, the test superuser may delete them.
    for (const model of [...TENANT_MODELS].filter((m) => m !== 'User').reverse()) await delegate(raw, model)['deleteMany']?.({ where: offices });
    await raw.user.deleteMany({ where: offices });
    await raw.office.deleteMany({ where: { id: { in: [a.officeId, b.officeId] } } });
    await prisma.onModuleDestroy();
  });

  it('should cover every tenant model', () => {
    expect(TENANT_ISOLATION_MATRIX.map((resource) => resource.model).sort()).toEqual([...TENANT_MODELS].sort());
  });

  describe.each(TENANT_ISOLATION_MATRIX.map((resource) => [resource.model, resource] as const))('%s', (model, resource: TenantResource) => {
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

        await expect(db['findMany']?.({ where: ids, select: { id: true } })).resolves.toEqual([{ id: own.id }]);
        await expect(db['count']?.({ where: ids })).resolves.toBe(1);
      }));

    it('should not find, update or delete another office row', () =>
      asOffice(a, async () => {
        const db = delegate(prisma.db, model);
        const where = { id: foreign.id };

        await expect(db['findUnique']?.({ where })).resolves.toBeNull();
        await expect(db['findFirst']?.({ where })).resolves.toBeNull();
        await expect(db['update']?.({ where, data: resource.update })).rejects.toMatchObject({ code: 'P2025' });
        await expect(db['updateMany']?.({ where, data: resource.update })).resolves.toEqual({ count: 0 });
        await expect(db['delete']?.({ where })).rejects.toMatchObject({ code: 'P2025' });
        await expect(db['deleteMany']?.({ where })).resolves.toEqual({ count: 0 });
      }));

    it('should still reach its own row', () =>
      asOffice(a, async () => {
        await expect(delegate(prisma.db, model)['findUnique']?.({ where: { id: own.id } })).resolves.toMatchObject({ id: own.id });
      }));

    it('should refuse to run without an office in context', async () => {
      await expect(delegate(prisma.db, model)['findMany']?.()).rejects.toThrow(TenantContextMissingError);
    });
  });

  it('should inject the current office on create and reject a foreign one', () =>
    asOffice(a, async () => {
      const created = await prisma.db.notification.create({
        data: { userId: a.userId, type: 'TEST', titleKey: 'test.title' } as never,
      });
      expect(created.officeId).toBe(a.officeId);
      await expect(
        prisma.db.notification.create({ data: { officeId: b.officeId, userId: b.userId, type: 'TEST', titleKey: 't' } }),
      ).rejects.toThrow(TenantViolationError);
    }));

  it('should reject nested writes into tenant models', () =>
    asOffice(a, async () => {
      await expect(
        prisma.db.user.update({
          where: { id: a.userId },
          data: { notifications: { create: { officeId: a.officeId, type: 'TEST', titleKey: 't' } } } as never,
        }),
      ).rejects.toThrow(TenantViolationError);
    }));

  it('should limit Office to the current office and scope tenant lists included from a global model', () =>
    asOffice(a, async () => {
      await expect(prisma.db.office.findMany({ select: { id: true } })).resolves.toEqual([{ id: a.officeId }]);
      const plan = await prisma.db.plan.findUniqueOrThrow({ where: { id: a.planId }, include: { subscriptions: true } });
      expect(plan.subscriptions.every((subscription) => subscription.officeId === a.officeId)).toBe(true);
      expect(plan.subscriptions.length).toBeGreaterThan(0);
    }));

  it('should keep the scope inside interactive transactions', () =>
    asOffice(a, async () => {
      const offices = await prisma.db.$transaction(async (tx) =>
        (await tx.user.findMany({ select: { officeId: true } })).map((user) => user.officeId),
      );
      expect(offices.length).toBeGreaterThan(0);
      expect(new Set(offices)).toEqual(new Set([a.officeId]));
      await expect(prisma.unscoped().user.count({ where: { officeId: b.officeId } })).resolves.toBeGreaterThan(0);
    }));

  it('should only allow raw SQL on tenant tables with the current officeId as a parameter', () =>
    asOffice(a, async () => {
      await expect(prisma.db.$queryRaw`SELECT count(*)::int AS n FROM users`).rejects.toThrow(TenantViolationError);
      await expect(
        prisma.db.$queryRaw<[{ n: number }]>`SELECT count(*)::int AS n FROM users WHERE office_id = ${a.officeId}::uuid`,
      ).resolves.toEqual([{ n: expect.any(Number) }]);
      await expect(prisma.db.$queryRaw`SELECT nlq_normalize_ar(${'محكمة'}) AS v`).resolves.toEqual([{ v: 'محكمه' }]);
    }));

  it.todo('HTTP: list/get/update/delete of another office resource → 404 RES-001 (entries gain `http` with MVP-40 auth)');
});
