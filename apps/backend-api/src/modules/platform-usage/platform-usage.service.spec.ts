import type { ModuleRef } from '@nestjs/core';

import { PlatformUsageController } from './platform-usage.controller';
import { PlatformUsageService } from './platform-usage.service';
import { QUEUE_NAMES } from '../../common/queue/queues';
import type { PrismaService } from '../../database/prisma.service';
import { EXPORT_MAX_ROWS } from '../audit-log/audit-log.service';

const OFFICE = '01920000-0000-7000-8000-0000000000b1';
const ADMIN = '01920000-0000-7000-8000-0000000000c1';
const NOW = new Date('2026-11-15T10:00:00.000Z');
const row = (n: number, extra: object = {}) => ({
  id: `01920000-0000-7000-8000-${String(n).padStart(12, '0')}`,
  createdAt: NOW,
  action: 'OFFICE_SUSPENDED',
  entityType: 'Office',
  entityId: OFFICE,
  targetOfficeId: OFFICE,
  oldValues: { isActive: true },
  newValues: { isActive: false },
  admin: { id: ADMIN, fullName: 'Rana Admin' },
  ...extra,
});

function setup({
  audit = [row(1), row(2, { admin: null, targetOfficeId: null, oldValues: null, newValues: [] })],
} = {}) {
  const raw = {
    $queryRaw: jest.fn().mockResolvedValue([{ date: '2026-11-15', cost: '0.375', ops: 2 }]),
    aiUsage: {
      groupBy: jest.fn().mockResolvedValue([
        { officeId: OFFICE, model: 'm', _sum: { costUsd: '0.375' }, _count: { _all: 2 } },
        { officeId: OFFICE, model: 'n', _sum: { costUsd: null }, _count: { _all: 1 } },
      ]),
    },
    documentVersion: {
      groupBy: jest.fn().mockResolvedValue([
        { officeId: OFFICE, _sum: { sizeBytes: 2048n } },
        { officeId: ADMIN, _sum: { sizeBytes: null } },
      ]),
    },
    user: { count: jest.fn().mockResolvedValueOnce(3).mockResolvedValueOnce(9) },
    office: {
      findMany: jest
        .fn()
        .mockImplementation(({ select }: { select: { name?: boolean } }) =>
          Promise.resolve(select.name ? [{ id: OFFICE, name: 'Haddad Law' }] : [{ id: OFFICE }]),
        ),
      count: jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(0),
    },
    platformAuditLog: { findMany: jest.fn().mockResolvedValue(audit) },
  };
  const counts = { waiting: 1, active: 0, delayed: 2, failed: 3 };
  const moduleRef = {
    get: jest.fn((token: string) => ({
      getJobCounts: String(token).includes(QUEUE_NAMES[0] ?? '-')
        ? jest.fn().mockRejectedValue(new Error('redis down'))
        : jest.fn().mockResolvedValue(counts),
    })),
  };
  const service = new PlatformUsageService(
    { unscoped: () => raw } as unknown as PrismaService,
    moduleRef as unknown as ModuleRef,
  );
  return { service, raw };
}

describe('PlatformUsageService (D-183)', () => {
  it('should answer an empty funnel with zeros and no median or cohort when nobody signed up (D-215)', async () => {
    const { service, raw } = setup();
    raw.$queryRaw.mockReset().mockResolvedValue([]);
    const analytics = await service.analytics(30, NOW);
    expect(analytics.since).toBe('2026-10-16');
    expect(analytics.funnel.every((step) => step.offices === 0)).toBe(true);
    expect(analytics.onboardingSteps.every((step) => step.offices === 0)).toBe(true);
    expect(analytics.medianSecondsToFirstCase).toBeNull();
    expect(analytics.retention).toEqual({
      d7: { offices: 0, retained: 0 },
      d30: { offices: 0, retained: 0 },
    });
  });

  it('should sum AI cost, storage, active users and the signup funnel', async () => {
    const { service } = setup();
    const usage = await service.usage(30, NOW);
    expect(usage.since).toBe('2026-10-16');
    expect(usage.aiCostByDay).toEqual([{ date: '2026-11-15', costUsd: '0.375', operations: 2 }]);
    expect(usage.aiCostByOffice).toEqual([
      { officeId: OFFICE, officeName: 'Haddad Law', model: 'm', costUsd: '0.375', operations: 2 },
      { officeId: OFFICE, officeName: 'Haddad Law', model: 'n', costUsd: '0', operations: 1 },
    ]);
    expect(usage.storageByOffice).toEqual([
      { officeId: OFFICE, officeName: 'Haddad Law', bytes: '2048' },
      { officeId: ADMIN, officeName: '', bytes: '0' },
    ]);
    expect(usage.activeUsers).toEqual({ daily: 3, weekly: 9 });
    expect(usage.signups).toEqual({ offices: 1, verified: 1, withCase: 0 });
  });

  it('should show zeros for a queue Redis cannot answer for', async () => {
    const { service } = setup();
    const queues = await service.queues();
    expect(queues).toHaveLength(QUEUE_NAMES.length);
    expect(queues[0]).toEqual({
      name: QUEUE_NAMES[0],
      waiting: 0,
      active: 0,
      delayed: 0,
      failed: 0,
    });
    expect(queues[1]).toMatchObject({ failed: 3, delayed: 2 });
  });

  it('should page the platform audit with its filters and name the office', async () => {
    const { service, raw } = setup();
    const page = await service.audit({
      limit: 1,
      cursor: ADMIN,
      officeId: OFFICE,
      adminId: ADMIN,
      action: 'OFFICE_SUSPENDED',
      from: '2026-11-01',
      to: '2026-11-15',
    });
    expect(page.items).toEqual([
      expect.objectContaining({
        admin: { id: ADMIN, name: 'Rana Admin' },
        office: { id: OFFICE, name: 'Haddad Law' },
        changes: [{ field: 'isActive', old: true, new: false }],
      }),
    ]);
    expect(page.nextCursor).toBe(row(1).id);
    const where = raw.platformAuditLog.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({
      targetOfficeId: OFFICE,
      adminId: ADMIN,
      action: 'OFFICE_SUSPENDED',
    });
    expect(where.createdAt.lt.toISOString()).toBe('2026-11-16T00:00:00.000Z');
    const all = await service.audit({ limit: 10, from: '2026-11-01' });
    expect(all.items[1]).toMatchObject({ admin: null, office: null, changes: [] });
    expect(all.nextCursor).toBeNull();
    await service.audit({ limit: 10, to: '2026-11-01' });
  });

  it('should export the audit as CSV and refuse more than the cap', async () => {
    const { service } = setup();
    const csv = await service.exportCsv({});
    expect(csv).toContain('"Rana Admin","OFFICE_SUSPENDED","Haddad Law"');
    const big = setup({ audit: Array.from({ length: EXPORT_MAX_ROWS + 1 }, (_, i) => row(i)) });
    await expect(big.service.exportCsv({})).rejects.toMatchObject({ code: 'BIZ-025' });
  });

  it('should answer through the controller', async () => {
    const usage = {
      usage: jest.fn().mockResolvedValue({}),
      queues: jest.fn().mockResolvedValue([]),
      audit: jest.fn().mockResolvedValue({ items: [], nextCursor: null }),
      exportCsv: jest.fn().mockResolvedValue('csv'),
    };
    const controller = new PlatformUsageController(usage as unknown as PlatformUsageService);
    await controller.get({ days: 30 });
    expect(usage.usage).toHaveBeenCalledWith(30);
    await controller.queues();
    await controller.audit({ limit: 50 });
    await expect(controller.export({})).resolves.toBeDefined();
  });
});
