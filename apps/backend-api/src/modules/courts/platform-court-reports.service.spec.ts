import type { PinoLogger } from 'nestjs-pino';

import { PlatformCourtReportsService } from './platform-court-reports.service';
import {
  BusinessRuleException,
  ResourceNotFoundException,
} from '../../common/errors/app.exception';
import type { TenantRunner } from '../../common/tenancy/tenant-runner';
import type { PrismaService } from '../../database/prisma.service';
import type { NotificationService } from '../notifications/notification.service';
import type { PlatformAuditService } from '../platform-auth/platform-audit.service';

const NOW = new Date('2026-11-28T10:00:00Z');
const CLIENT = { ip: '127.0.0.1', userAgent: 'jest', requestId: 'req-12345678' };

const report = (overrides: Record<string, unknown> = {}) => ({
  id: 'r1',
  officeId: 'office-1',
  name: 'محكمة صلح يطا',
  city: 'يطا',
  note: null,
  status: 'PENDING',
  courtId: null,
  dismissReason: null,
  resolvedAt: null,
  createdAt: NOW,
  reportedById: 'user-1',
  office: { name: 'مكتب', jurisdiction: 'PALESTINE' },
  reportedBy: { fullName: 'محامي' },
  ...overrides,
});

function setup() {
  const raw = {
    courtReport: {
      findMany: jest.fn().mockResolvedValue([report()]),
      count: jest.fn().mockResolvedValue(1),
      findUnique: jest.fn().mockResolvedValue(report()),
      update: jest.fn(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve(report({ ...data, resolvedAt: NOW })),
      ),
    },
    court: { create: jest.fn().mockResolvedValue({ id: 'court-9' }) },
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
  const db = Object.assign(raw, {
    $transaction: jest.fn((work: (tx: typeof raw) => Promise<unknown>) => work(raw)),
  });
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const tenant = { run: jest.fn((_ctx: unknown, work: () => Promise<unknown>) => work()) };
  const notifications = { notify: jest.fn().mockResolvedValue(undefined) };
  const logger = { setContext: jest.fn(), error: jest.fn() };
  const service = new PlatformCourtReportsService(
    { unscoped: () => db } as unknown as PrismaService,
    audit as unknown as PlatformAuditService,
    tenant as unknown as TenantRunner,
    notifications as unknown as NotificationService,
    logger as unknown as PinoLogger,
  );
  return { db, audit, tenant, notifications, logger, service };
}

describe('PlatformCourtReportsService', () => {
  it('should list reports oldest first, filtered by status when asked', async () => {
    const { db, service } = setup();
    const page = await service.list({ status: 'PENDING', page: 1, limit: 50 });
    expect(page.items[0]).toMatchObject({
      officeName: 'مكتب',
      jurisdiction: 'PALESTINE',
      reportedByName: 'محامي',
      resolvedAt: null,
    });
    expect(page.items[0]).not.toHaveProperty('reportedById');
    expect(db.courtReport.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { status: 'PENDING' },
    });
    await service.list({ page: 1, limit: 50 });
    expect(db.courtReport.findMany.mock.calls[1]?.[0]).toMatchObject({ where: {} });
  });

  it("should add the court in the office's country, link it, audit and notify the reporter", async () => {
    const { db, audit, tenant, notifications, service } = setup();
    const added = await service.add(
      'r1',
      { courtType: 'MAGISTRATE', nameAr: 'محكمة صلح يطا', nameEn: 'Yatta Magistrate Court' },
      'admin-1',
      CLIENT,
    );
    expect(db.court.create.mock.calls[0]?.[0]).toMatchObject({
      data: { jurisdiction: 'PALESTINE', nameEn: 'Yatta Magistrate Court' },
    });
    expect(added).toMatchObject({ status: 'ADDED', courtId: 'court-9' });
    expect(added).not.toHaveProperty('reportedById');
    expect(db.courtReport.update.mock.calls[0]?.[0].data).toMatchObject({
      resolvedById: 'admin-1',
    });
    expect(audit.log.mock.calls[0]?.[0]).toMatchObject({
      action: 'COURT_REPORT_ADDED',
      entityType: 'CourtReport',
      targetOfficeId: 'office-1',
    });
    expect(tenant.run.mock.calls[0]?.[0]).toEqual({ officeId: 'office-1' });
    expect(notifications.notify).toHaveBeenCalledWith(
      ['user-1'],
      expect.objectContaining({
        type: 'COURT_REPORT_RESOLVED',
        titleKey: 'common.notifications.courtReportAdded',
      }),
      { jobId: 'court-report-r1' },
    );
  });

  it('should dismiss with or without a reason', async () => {
    const { db, notifications, service } = setup();
    await service.dismiss('r1', { reason: 'موجودة باسم آخر' }, 'admin-1', CLIENT);
    expect(db.courtReport.update.mock.calls[0]?.[0].data).toMatchObject({
      status: 'DISMISSED',
      dismissReason: 'موجودة باسم آخر',
    });
    expect(notifications.notify.mock.calls[0]?.[1]).toMatchObject({
      titleKey: 'common.notifications.courtReportDismissed',
      params: { reason: 'موجودة باسم آخر' },
    });
    await service.dismiss('r1', {}, 'admin-1', CLIENT);
    expect(db.courtReport.update.mock.calls[1]?.[0].data).toMatchObject({ dismissReason: null });
  });

  it('should resolve once (BIZ-029) and 404 an unknown report', async () => {
    const { db, service } = setup();
    db.courtReport.findUnique.mockResolvedValueOnce(report({ status: 'ADDED' }));
    await expect(service.dismiss('r1', {}, 'a', CLIENT)).rejects.toBeInstanceOf(
      BusinessRuleException,
    );
    db.courtReport.findUnique.mockResolvedValueOnce(null);
    await expect(service.dismiss('rX', {}, 'a', CLIENT)).rejects.toBeInstanceOf(
      ResourceNotFoundException,
    );
  });

  it('should keep the resolution when the notification cannot be queued', async () => {
    const { notifications, logger, service } = setup();
    notifications.notify.mockRejectedValueOnce(new Error('redis down'));
    await expect(service.dismiss('r1', {}, 'a', CLIENT)).resolves.toMatchObject({
      status: 'DISMISSED',
    });
    expect(logger.error).toHaveBeenCalled();
  });
});
