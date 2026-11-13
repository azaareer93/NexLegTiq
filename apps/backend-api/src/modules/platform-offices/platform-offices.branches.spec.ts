import { PlatformOfficesController } from './platform-offices.controller';
import { PlatformOfficesService } from './platform-offices.service';
import { ResourceNotFoundException } from '../../common/errors/app.exception';

const client = { ip: '127.0.0.1', userAgent: null, requestId: null };
const created = new Date('2026-01-02T00:00:00Z');
const baseRow = {
  id: 'o1',
  name: 'Office',
  jurisdiction: 'PALESTINE',
  is_active: true,
  created_at: created,
  plan_code: 'PS_FREE',
  plan_name: null,
  sub_status: 'ACTIVE',
  last_write_at: null,
};

interface Opts {
  rows?: unknown[];
  total?: bigint | null;
  active?: boolean;
  auditRow?: unknown;
  updated?: number;
  exists?: boolean;
  usersFail?: boolean;
}

function build(o: Opts = {}) {
  const tx = {
    office: { updateMany: jest.fn().mockResolvedValue({ count: o.updated ?? 1 }) },
    refreshToken: { updateMany: jest.fn() },
  };
  const queries: { sql: string; values: unknown[] }[] = [];
  const raw = {
    $transaction: jest.fn((work: (t: typeof tx) => unknown) => work(tx)),
    $queryRaw: jest.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      queries.push({ sql, values });
      if (sql.includes('count(*)')) {
        return Promise.resolve(o.total === null ? [] : [{ total: o.total ?? 1n }]);
      }
      return Promise.resolve(o.rows ?? [baseRow]);
    }),
    user: {
      groupBy: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(2),
      findMany: o.usersFail
        ? jest.fn().mockRejectedValue(new Error('db'))
        : jest.fn().mockResolvedValue([{ id: 'u1' }, { id: 'u2' }]),
    },
    legalFile: {
      groupBy: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(1),
    },
    document: { count: jest.fn().mockResolvedValue(3) },
    auditLog: { count: jest.fn().mockResolvedValue(4) },
    officeSettings: { findUnique: jest.fn().mockResolvedValue(null) },
    documentVersion: { groupBy: jest.fn().mockResolvedValue([]) },
    aiUsage: { groupBy: jest.fn().mockResolvedValue([]) },
    office: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        isActive: o.active ?? true,
        accountType: 'FIRM',
        email: null,
        phone: null,
        currency: 'ILS',
        timezone: 'Asia/Hebron',
      }),
      findUnique: jest.fn().mockResolvedValue(o.exists === false ? null : { id: 'o1' }),
    },
    subscription: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 's1',
          plan: { code: 'PS_FREE', name: 'Free' },
          status: 'ACTIVE',
          currentPeriodStart: created,
          currentPeriodEnd: null,
          trialEndsAt: created,
          createdAt: created,
        },
      ]),
    },
    platformAuditLog: { findFirst: jest.fn().mockResolvedValue(o.auditRow ?? null) },
  };
  const audit = { log: jest.fn() };
  const entitlements = { invalidate: jest.fn() };
  const realtime = { disconnectUser: jest.fn() };
  const logger = { warn: jest.fn() };
  const service = new PlatformOfficesService(
    { unscoped: () => raw } as never,
    audit as never,
    entitlements as never,
    realtime as never,
    logger as never,
  );
  return { service, raw, tx, audit, entitlements, realtime, logger, queries };
}

describe('PlatformOfficesService list', () => {
  it('should pass filters as bound parameters and page offsets', async () => {
    const { service, queries } = build({ total: 41n });
    const result = await service.list({
      page: 3,
      limit: 10,
      search: '50%_a',
      status: 'ACTIVE',
      plan: 'PS_FREE',
      jurisdiction: 'PALESTINE',
      createdFrom: '2026-01-01',
      createdTo: '2026-02-01',
    } as never);
    const page = queries.find((q) => !q.sql.includes('count(*)'));
    const [writes, source, limit, offset] = page?.values as [
      { values: unknown[] },
      { values: unknown[] },
      number,
      number,
    ];
    expect(writes.values).toEqual(['CREATE', 'UPDATE', 'DELETE', 'SHARE']);
    expect(source.values).toEqual(
      expect.arrayContaining(['50\\%\\_a', 'ACTIVE', 'PS_FREE', 'PALESTINE', '2026-01-01']),
    );
    expect([limit, offset]).toEqual([10, 20]);
    expect(result.items[0]).toMatchObject({
      status: 'ACTIVE',
      plan: { code: 'PS_FREE', name: 'PS_FREE' },
      lastActivityAt: null,
      usage: { activeUsers: 0, storageMb: 0 },
    });
    expect(result.pagination.total).toBe(41);
  });

  it('should give an empty page with the total when the page is past the end', async () => {
    const { service, raw } = build({ rows: [], total: 5n });
    const result = await service.list({ page: 9, limit: 10 } as never);
    expect(result.items).toEqual([]);
    expect(result.pagination.total).toBe(5);
    expect(raw.user.groupBy).not.toHaveBeenCalled();
  });

  it('should count zero when the count query returns nothing', async () => {
    const { service } = build({ rows: [], total: null });
    const result = await service.list({ page: 1, limit: 10 } as never);
    expect(result.pagination.total).toBe(0);
  });
});

describe('PlatformOfficesService get', () => {
  it('should count files per status, default the switches without settings and flag a quiet office', async () => {
    const { service, raw } = build({
      rows: [{ ...baseRow, last_write_at: new Date('2026-01-03T00:00:00Z') }],
    });
    raw.legalFile.groupBy.mockImplementation(({ by }: { by: string[] }) =>
      Promise.resolve(by[0] === 'status' ? [{ status: 'CLOSED', _count: { _all: 5 } }] : []),
    );
    const detail = await service.get('o1');
    expect(detail.statistics).toEqual({
      signedIn30d: 2,
      filesByStatus: { OPEN: 0, SUSPENDED: 0, CLOSED: 5, ARCHIVED: 0 },
      filesNew30d: 1,
      documents: 3,
      documentsNew30d: 3,
      writes30d: 4,
      aiEnabled: true,
      ocrEnabled: true,
    });
    expect(detail).toMatchObject({ lastWriteAt: '2026-01-03T00:00:00.000Z', atRisk: true });
  });

  it('should answer 404 for an unknown office', async () => {
    const { service } = build({ rows: [] });
    await expect(service.get('missing')).rejects.toBeInstanceOf(ResourceNotFoundException);
  });

  it('should have no suspension for an active office', async () => {
    const { service, raw } = build();
    const detail = await service.get('o1');
    expect(detail.suspension).toBeNull();
    expect(detail.subscriptions).toHaveLength(1);
    expect(raw.platformAuditLog.findFirst).not.toHaveBeenCalled();
  });

  it('should have no suspension when the audit row has no string reason', async () => {
    const { service } = build({
      active: false,
      auditRow: { createdAt: created, newValues: { reason: 5 } },
    });
    expect((await service.get('o1')).suspension).toBeNull();
  });

  it('should have no suspension when the audit row has no values', async () => {
    const { service } = build({ active: false, auditRow: { createdAt: created, newValues: null } });
    expect((await service.get('o1')).suspension).toBeNull();
  });

  it('should give the reason of a suspended office', async () => {
    const { service } = build({
      active: false,
      auditRow: { createdAt: created, newValues: { reason: 'abuse' } },
    });
    expect((await service.get('o1')).suspension).toEqual({
      at: created.toISOString(),
      reason: 'abuse',
    });
  });
});

describe('PlatformOfficesService suspend and reactivate', () => {
  it('should revoke sessions, audit, invalidate and close sockets on suspend', async () => {
    const { service, tx, audit, entitlements, realtime } = build();
    await service.suspend('o1', 'abuse', 'a1', client);
    expect(tx.refreshToken.updateMany).toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'OFFICE_SUSPENDED', newValues: { reason: 'abuse' } }),
      client,
      tx,
    );
    expect(entitlements.invalidate).toHaveBeenCalledWith('o1');
    expect(realtime.disconnectUser).toHaveBeenCalledTimes(2);
  });

  it('should audit reactivation with its reason and keep sockets alone', async () => {
    const { service, tx, audit, entitlements, realtime } = build();
    await service.reactivate('o1', 'paid', 'a1', client);
    expect(tx.refreshToken.updateMany).not.toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'OFFICE_REACTIVATED', newValues: { reason: 'paid' } }),
      client,
      tx,
    );
    expect(entitlements.invalidate).toHaveBeenCalledWith('o1');
    expect(realtime.disconnectUser).not.toHaveBeenCalled();
  });

  it('should audit reactivation without a reason as empty values', async () => {
    const { service, audit } = build();
    await service.reactivate('o1', undefined, 'a1', client);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ newValues: {} }),
      client,
      expect.anything(),
    );
  });

  it('should do nothing when suspending an already suspended office', async () => {
    const { service, audit, entitlements, realtime } = build({ updated: 0 });
    await service.suspend('o1', 'abuse', 'a1', client);
    expect(audit.log).not.toHaveBeenCalled();
    expect(entitlements.invalidate).not.toHaveBeenCalled();
    expect(realtime.disconnectUser).not.toHaveBeenCalled();
  });

  it('should answer 404 when the update changed nothing and the office is gone', async () => {
    const { service } = build({ updated: 0, exists: false });
    await expect(service.reactivate('o1', undefined, 'a1', client)).rejects.toBeInstanceOf(
      ResourceNotFoundException,
    );
  });

  it('should log and not throw when closing sockets fails', async () => {
    const { service, logger, realtime } = build({ usersFail: true });
    await expect(service.suspend('o1', 'abuse', 'a1', client)).resolves.toBeDefined();
    expect(logger.warn).toHaveBeenCalled();
    expect(realtime.disconnectUser).not.toHaveBeenCalled();
  });
});

describe('PlatformOfficesController', () => {
  function controller() {
    const offices = {
      list: jest.fn().mockResolvedValue('list'),
      view: jest.fn().mockResolvedValue('detail'),
      suspend: jest.fn().mockResolvedValue('s'),
      reactivate: jest.fn().mockResolvedValue('r'),
    };
    const cls = { isActive: jest.fn().mockReturnValue(false), getId: jest.fn() };
    const c = new PlatformOfficesController(offices as never, cls as never);
    return { c, offices };
  }
  const req = (id?: string) =>
    ({ platformAdminId: id, ip: '1.2.3.4', get: () => undefined }) as never;

  it('should audit the detail view through the service with the admin id', async () => {
    const { c, offices } = controller();
    await expect(c.get('o1', req('a1'))).resolves.toBe('detail');
    expect(offices.view).toHaveBeenCalledWith('o1', 'a1', expect.anything());
  });

  it('should list, suspend with a trimmed reason and reactivate', async () => {
    const { c, offices } = controller();
    await c.list({ page: 1, limit: 10 } as never);
    await c.suspend('o1', { reason: '  abuse ' }, req('a1'));
    expect(offices.suspend).toHaveBeenCalledWith('o1', 'abuse', 'a1', expect.anything());
    await c.reactivate('o1', { reason: '  ' }, req('a1'));
    expect(offices.reactivate).toHaveBeenCalledWith('o1', undefined, 'a1', expect.anything());
  });

  it('should fail when the admin guard did not run', () => {
    const { c } = controller();
    expect(() => c.get('o1', req())).toThrow('AdminAuthGuard did not run');
  });
});

describe('PlatformOfficesService usage', () => {
  it('should fill usage from the grouped queries', async () => {
    const { service, raw } = build({ total: 1n });
    const last = new Date('2026-03-01T00:00:00Z');
    raw.user.groupBy
      .mockResolvedValueOnce([{ officeId: 'o1', _count: { _all: 4 } }])
      .mockResolvedValueOnce([{ officeId: 'o1', _max: { lastLoginAt: last } }]);
    raw.legalFile.groupBy.mockResolvedValue([{ officeId: 'o1', _count: { _all: 7 } }]);
    raw.documentVersion.groupBy.mockResolvedValue([
      { officeId: 'o1', _sum: { sizeBytes: 1024n * 1024n + 1n } },
    ]);
    raw.aiUsage.groupBy.mockResolvedValue([{ officeId: 'o1', _count: { _all: 3 } }]);
    const { items } = await service.list({ page: 1, limit: 10 } as never);
    expect(items[0]).toMatchObject({
      usage: { activeUsers: 4, liveFiles: 7, storageMb: 2, aiThisMonth: 3 },
      lastActivityAt: last.toISOString(),
    });
  });

  it('should treat a null byte sum as zero and show a plan name', async () => {
    const { service, raw } = build({ rows: [{ ...baseRow, plan_name: 'Free', is_active: false }] });
    raw.documentVersion.groupBy.mockResolvedValue([{ officeId: 'o1', _sum: { sizeBytes: null } }]);
    const { items } = await service.list({ page: 1, limit: 10 } as never);
    expect(items[0]).toMatchObject({
      status: 'SUSPENDED',
      plan: { name: 'Free' },
      usage: { storageMb: 0 },
    });
  });

  it('should show a null plan when the office has no subscription', async () => {
    const { service } = build({ rows: [{ ...baseRow, plan_code: null, sub_status: null }] });
    const { items } = await service.list({ page: 1, limit: 10 } as never);
    expect(items[0]?.plan).toBeNull();
  });
});
