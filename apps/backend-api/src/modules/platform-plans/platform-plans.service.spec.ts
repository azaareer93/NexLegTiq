import { PlatformPlansService } from './platform-plans.service';
import { Prisma } from '../../generated/prisma/client';

const client = { ip: '1.2.3.4', userAgent: null, requestId: 'r1' };

function plan(over: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    code: 'PS_PRO',
    name: 'Pro',
    market: 'PALESTINE',
    priceMonthly: new Prisma.Decimal('25'),
    currency: 'USD',
    maxUsers: 5,
    aiQuotaMonthly: null,
    ocrPagesMonthly: 0,
    storageQuotaMb: 1024,
    trialDays: null,
    features: { ai: true },
    isActive: true,
    sortOrder: 1,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-02T00:00:00Z'),
    _count: { subscriptions: 0 },
    ...over,
  };
}

function build(found: unknown = plan(), deleteError?: unknown) {
  const tx = {
    plan: {
      findMany: jest.fn().mockResolvedValue([plan()]),
      findUnique: jest.fn().mockResolvedValue(found),
      create: jest.fn().mockResolvedValue(plan()),
      update: jest.fn().mockResolvedValue(plan({ name: 'Pro+' })),
      delete: deleteError
        ? jest.fn().mockRejectedValue(deleteError)
        : jest.fn().mockResolvedValue({}),
    },
  };
  const raw = { ...tx, $transaction: (fn: (t: typeof tx) => unknown) => fn(tx) };
  const audit = { log: jest.fn() };
  const entitlements = { invalidateAll: jest.fn() };
  const service = new PlatformPlansService(
    { unscoped: () => raw } as never,
    audit as never,
    entitlements as never,
  );
  return { service, tx, audit, entitlements };
}

describe('PlatformPlansService', () => {
  it('should list plans with their use and money as a decimal string', async () => {
    const [item] = await build().service.list();
    expect(item).toMatchObject({
      priceMonthly: '25.00',
      subscriptionCount: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('should audit a created plan', async () => {
    const { service, audit } = build();
    await service.create({ code: 'PS_PRO' } as never, 'a1', client);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'PLAN_CREATED', entityId: 'p1' }),
      client,
      expect.anything(),
    );
  });

  it('should audit an update with old and new values and drop every cached entitlement', async () => {
    const { service, audit, entitlements } = build();
    await expect(service.update('p1', { name: 'Pro+' }, 'a1', client)).resolves.toMatchObject({
      name: 'Pro+',
    });
    expect(audit.log.mock.calls[0][0]).toMatchObject({
      action: 'PLAN_UPDATED',
      oldValues: { name: 'Pro' },
      newValues: { name: 'Pro+' },
    });
    expect(entitlements.invalidateAll).toHaveBeenCalled();
  });

  it('should neither audit nor drop the cache when nothing changed', async () => {
    const { service, tx, audit, entitlements } = build();
    tx.plan.update.mockResolvedValueOnce(plan());
    await service.update('p1', { name: 'Pro' }, 'a1', client);
    expect(audit.log).not.toHaveBeenCalled();
    expect(entitlements.invalidateAll).not.toHaveBeenCalled();
  });

  it('should answer BIZ-022 when a subscription arrived before the delete, and pass other errors on', async () => {
    const fk = Object.assign(new Error('fk'), {
      name: 'PrismaClientKnownRequestError',
      code: 'P2003',
    });
    await expect(build(plan(), fk).service.remove('p1', 'a1', client)).rejects.toMatchObject({
      code: 'BIZ-022',
    });
    await expect(
      build(plan(), new Error('down')).service.remove('p1', 'a1', client),
    ).rejects.toThrow('down');
  });

  it('should answer 404 for an unknown plan', async () => {
    const { service } = build(null);
    await expect(service.update('p1', { name: 'x' }, 'a1', client)).rejects.toMatchObject({
      code: 'RES-001',
    });
    await expect(service.remove('p1', 'a1', client)).rejects.toMatchObject({ code: 'RES-001' });
  });

  it('should delete an unused plan and refuse one in use (BIZ-022)', async () => {
    const unused = build();
    await unused.service.remove('p1', 'a1', client);
    expect(unused.tx.plan.delete).toHaveBeenCalledWith({ where: { id: 'p1' } });
    expect(unused.audit.log.mock.calls[0][0]).toMatchObject({ action: 'PLAN_DELETED' });

    const used = build(plan({ _count: { subscriptions: 2 } }));
    await expect(used.service.remove('p1', 'a1', client)).rejects.toMatchObject({
      code: 'BIZ-022',
    });
    expect(used.tx.plan.delete).not.toHaveBeenCalled();
  });
});
