import type { ClsService } from 'nestjs-cls';

import { addDays, DashboardService, deadlines } from './dashboard.service';
import type { RequestContext } from '../../common/context/request-context';
import type { PrismaService } from '../../database/prisma.service';
import type { DocumentAccessService } from '../documents/document-access.service';
import type { InvoiceAccess } from '../invoices/invoice-access';
import type { CaseAccessService } from '../legal-files/case-access.service';
import type { TimelineService } from '../timeline/timeline.service';

const ID = (n: number) => `01920000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const FILE = { id: ID(1), fileNumber: 'F-1', title: 'Rent' };
const NOW = new Date('2026-11-09T08:00:00.000Z'); // 10:00 in Hebron

function setup(context: Partial<RequestContext>) {
  const hearing = (n: number, startsAt: string) => ({
    id: ID(n),
    sessionType: 'HEARING',
    startsAt: new Date(startsAt),
    file: FILE,
  });
  const db = {
    office: { findFirstOrThrow: jest.fn().mockResolvedValue({ timezone: 'Asia/Hebron' }) },
    legalFile: {
      count: jest.fn().mockResolvedValueOnce(3).mockResolvedValueOnce(1),
      groupBy: jest.fn().mockResolvedValue([{ responsibleLawyerId: ID(7), _count: { _all: 2 } }]),
    },
    session: {
      findMany: jest
        .fn()
        .mockResolvedValueOnce([
          hearing(10, '2026-11-09T07:00:00Z'),
          hearing(11, '2026-11-09T08:30:00Z'),
        ])
        .mockResolvedValueOnce([hearing(11, '2026-11-09T08:30:00Z')]),
      count: jest.fn().mockResolvedValue(4),
    },
    task: {
      count: jest.fn().mockResolvedValue(2),
      findMany: jest
        .fn()
        .mockResolvedValue([
          { id: ID(20), title: 'Reply', dueDate: new Date('2026-11-09T00:00:00Z'), file: null },
        ]),
      groupBy: jest.fn().mockResolvedValue([{ assignedToId: ID(7), _count: { _all: 1 } }]),
    },
    document: { count: jest.fn().mockResolvedValue(5) },
    client: { count: jest.fn().mockResolvedValue(6) },
    invoice: {
      groupBy: jest
        .fn()
        .mockResolvedValueOnce([
          { currency: 'ILS', _sum: { total: { toFixed: () => '1500.5' } }, _count: { _all: 2 } },
        ])
        .mockResolvedValueOnce([{ currency: 'JOD', _sum: { total: null } }]),
      count: jest.fn().mockResolvedValue(1),
    },
    user: {
      findMany: jest.fn().mockResolvedValue([
        { id: ID(7), fullName: 'Omar' },
        { id: ID(8), fullName: 'Sami' },
      ]),
    },
  };
  const timeline = { recent: jest.fn().mockResolvedValue({ items: [], names: {} }) };
  const service = new DashboardService(
    { get: (key: keyof RequestContext) => context[key] } as unknown as ClsService<RequestContext>,
    { db } as unknown as PrismaService,
    { visibleWhere: () => ({ visible: true }) } as unknown as CaseAccessService,
    { visibleWhere: () => ({ doc: true }) } as unknown as DocumentAccessService,
    timeline as unknown as TimelineService,
    { visibleWhere: () => ({ invoice: true }) } as unknown as InvoiceAccess,
  );
  return { service, db };
}

describe('DashboardService (D-151)', () => {
  it("should gather a lawyer's day in the office's time zone, without team or client counts", async () => {
    const { service, db } = setup({ userId: ID(7), role: 'LAWYER', permissions: [] } as never);
    const data = await service.get(NOW);
    expect(data).toMatchObject({
      today: '2026-11-09',
      openFiles: { count: 3, openedThisWeek: 1 },
      overdueTasks: 2,
      newDocuments: 5,
      newClientsThisMonth: null,
      team: null,
      nextHearingId: ID(11),
    });
    expect(data.todayHearings).toHaveLength(2);
    // Today in Hebron starts at 22:00 UTC the day before.
    expect(db.session.findMany.mock.calls[0]?.[0].where.startsAt).toEqual({
      gte: new Date('2026-11-08T22:00:00.000Z'),
      lt: new Date('2026-11-09T22:00:00.000Z'),
    });
    expect(data.deadlines.map((d) => d.kind)).toEqual(['TASK', 'HEARING']);
    expect(db.client.count).not.toHaveBeenCalled();
    expect(data.finance).toBeNull();
    expect(db.invoice.groupBy).not.toHaveBeenCalled();
  });

  it('should sum visible unpaid and paid-this-month invoices per currency for invoice viewers', async () => {
    const { service, db } = setup({
      userId: ID(7),
      role: 'LAWYER',
      permissions: ['view:assigned:invoices'],
    } as never);
    const data = await service.get(NOW);
    expect(data.finance).toEqual({
      unpaid: [{ currency: 'ILS', amount: '1500.50', count: 2 }],
      overdueCount: 1,
      revenueThisMonth: [{ currency: 'JOD', amount: '0.000' }],
    });
    expect(db.invoice.groupBy.mock.calls[1]?.[0].where.AND).toEqual([
      { invoice: true },
      { status: 'PAID', paidAt: { gte: new Date('2026-10-31T22:00:00.000Z') } },
    ]);
  });

  it('should add the team workload and the new clients for the office manager', async () => {
    const { service, db } = setup({
      userId: ID(7),
      role: 'OFFICE_MANAGER',
      permissions: ['manage:clients'],
    } as never);
    const data = await service.get(NOW);
    expect(data.newClientsThisMonth).toBe(6);
    expect(db.client.count.mock.calls[0]?.[0].where.createdAt).toEqual({
      gte: new Date('2026-10-31T22:00:00.000Z'),
    });
    expect(data.team).toEqual({
      hearingsThisWeek: 4,
      workload: [
        { userId: ID(7), fullName: 'Omar', openFiles: 2, overdueTasks: 1 },
        { userId: ID(8), fullName: 'Sami', openFiles: 0, overdueTasks: 0 },
      ],
    });
  });

  it('should treat a caller without permissions as having none', async () => {
    const { service, db } = setup({ userId: ID(7), role: 'TRAINEE' } as never);
    expect((await service.get(NOW)).newClientsThisMonth).toBeNull();
    expect(db.client.count).not.toHaveBeenCalled();
  });

  it('should refuse to run without a caller', async () => {
    await expect(setup({}).service.get(NOW)).rejects.toThrow('No office caller');
  });

  it('should order deadlines by date, skip undated tasks and keep at most 20', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      id: ID(i),
      title: `T${i}`,
      dueDate:
        i === 0 ? null : new Date(`2026-11-${String(10 + (i % 5)).padStart(2, '0')}T00:00:00Z`),
      file: null,
    }));
    const items = deadlines([], many, (d) => new Date(`${d}T00:00:00Z`));
    expect(items).toHaveLength(20);
    expect(items.some((d) => d.id === ID(0))).toBe(false);
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});
