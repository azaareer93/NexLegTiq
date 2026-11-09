import type { ClsService } from 'nestjs-cls';

import { TimeEntriesService } from './time-entries.service';
import { roundedHours, TimerService } from './time-timer.service';
import type { AuditService } from '../../common/audit/audit.service';
import type { RequestContext } from '../../common/context/request-context';
import type { PrismaService } from '../../database/prisma.service';
import type { UnitOfWork } from '../../database/unit-of-work';
import { Prisma } from '../../generated/prisma/client';
import type { CaseAccessService } from '../legal-files/case-access.service';

const ID = (n: number) => `01920000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const FILE = { id: ID(1), fileNumber: 'F-1', title: 'Rent' };

const row = (overrides: object = {}) => ({
  id: ID(10),
  fileId: FILE.id,
  userId: ID(7),
  workDate: new Date('2026-11-09T00:00:00Z'),
  durationHours: new Prisma.Decimal('1.25'),
  description: 'Work',
  isBillable: true,
  hourlyRate: new Prisma.Decimal('150'),
  currency: 'ILS',
  invoiceId: null,
  createdAt: new Date('2026-11-09T08:00:00Z'),
  updatedAt: new Date('2026-11-09T08:00:00Z'),
  file: FILE,
  user: { id: ID(7), fullName: 'Omar' },
  ...overrides,
});

function setup(
  context: Partial<RequestContext> = { userId: ID(7), role: 'LAWYER', permissions: [] } as never,
) {
  const db = {
    timeEntry: {
      findMany: jest.fn().mockResolvedValue([row()]),
      findFirst: jest.fn().mockResolvedValue(row()),
      count: jest.fn().mockResolvedValue(1),
      create: jest.fn().mockResolvedValue({ id: ID(10) }),
      update: jest.fn(),
      delete: jest.fn(),
    },
    timeTimer: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    legalFile: {
      findFirstOrThrow: jest.fn().mockResolvedValue({ hourlyRate: null, currency: 'ILS' }),
    },
    officeSettings: { findFirst: jest.fn().mockResolvedValue(null) },
    office: { findFirstOrThrow: jest.fn().mockResolvedValue({ timezone: 'Asia/Hebron' }) },
    $queryRaw: jest.fn(),
  };
  const audit = { log: jest.fn() };
  const uow = { run: (work: (tx: typeof db) => unknown) => work(db) };
  const files = { visibleWhere: () => ({ visible: true }), assertFileAccess: jest.fn() };
  const cls = {
    get: (key: keyof RequestContext) =>
      (({ officeId: 'o1', ...context }) as Partial<RequestContext>)[key],
  } as unknown as ClsService<RequestContext>;
  const entries = new TimeEntriesService(
    cls,
    { db } as unknown as PrismaService,
    uow as unknown as UnitOfWork,
    files as unknown as CaseAccessService,
    audit as unknown as AuditService,
  );
  const timers = new TimerService(
    cls,
    { db } as unknown as PrismaService,
    uow as unknown as UnitOfWork,
    files as unknown as CaseAccessService,
    audit as unknown as AuditService,
    entries,
  );
  return { entries, timers, db, audit };
}

describe('time entries (D-152)', () => {
  it('should round a timer up to the increment, at least one, at most a day', () => {
    expect(roundedHours(7 * 60_000, 6).toFixed(2)).toBe('0.20');
    expect(roundedHours(0, 6).toFixed(2)).toBe('0.10');
    expect(roundedHours(61 * 60_000, 15).toFixed(2)).toBe('1.25');
    expect(roundedHours(10 * 60_000, 10).toFixed(2)).toBe('0.17');
    expect(roundedHours(30 * 3_600_000, 6).toFixed(2)).toBe('24.00');
  });

  it('should hide rates from readers without invoice rights and narrow others to their own entries', async () => {
    const { entries, db } = setup();
    const page = await entries.list({
      page: 1,
      limit: 20,
      billable: true,
      invoiced: false,
      from: '2026-11-01',
    });
    expect(page.items[0]).toMatchObject({ hourlyRate: null, amount: null, durationHours: '1.25' });
    expect(db.timeEntry.findMany.mock.calls[0]?.[0].where.AND[0]).toEqual({
      file: { visible: true },
      userId: ID(7),
    });
    expect(db.timeEntry.findMany.mock.calls[0]?.[0].where.AND[1]).toMatchObject({
      isBillable: true,
      invoiceId: null,
      workDate: { gte: new Date('2026-11-01T00:00:00Z') },
    });
  });

  it("should show the office manager everyone's entries with their amounts", async () => {
    const { entries, db } = setup({
      userId: ID(7),
      role: 'OFFICE_MANAGER',
      permissions: ['view:all:invoices'],
    } as never);
    const page = await entries.list({
      page: 1,
      limit: 20,
      invoiced: true,
      to: '2026-11-30',
      userId: ID(8),
    });
    expect(page.items[0]).toMatchObject({ hourlyRate: '150.00', amount: '187.50' });
    expect(db.timeEntry.findMany.mock.calls[0]?.[0].where.AND[0]).toEqual({
      file: { visible: true },
    });
  });

  it('should refuse an empty change, write nothing for an unchanged one, and lock invoiced entries', async () => {
    const { entries, db, audit } = setup();
    await expect(entries.update(ID(10), {})).rejects.toMatchObject({ code: 'VAL-001' });
    await entries.update(ID(10), { description: 'Work', workDate: '2026-11-09' });
    expect(db.timeEntry.update).not.toHaveBeenCalled();
    await entries.update(ID(10), { durationHours: '2', workDate: '2026-11-10' });
    expect(audit.log).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ oldValues: { durationHours: '1.25', workDate: '2026-11-09' } }),
    );
    db.timeEntry.findFirst.mockResolvedValueOnce(row({ invoiceId: ID(99) }));
    await expect(entries.remove(ID(10))).rejects.toMatchObject({ code: 'BIZ-006' });
    db.timeEntry.findFirst.mockResolvedValueOnce(null);
    await expect(entries.remove(ID(10))).rejects.toMatchObject({ code: 'RES-001' });
  });

  it('should log a new entry with the office default rate and today in the office zone', async () => {
    const { entries, db } = setup();
    db.officeSettings.findFirst.mockResolvedValueOnce({
      defaultBillingRate: new Prisma.Decimal('90'),
      timeIncrementMinutes: 6,
    });
    await entries.create({ fileId: FILE.id, durationHours: '1', description: 'Call' });
    expect(db.timeEntry.create.mock.calls[0]?.[0].data).toMatchObject({
      hourlyRate: new Prisma.Decimal('90'),
      isBillable: true,
      currency: 'ILS',
    });
  });

  it('should start one timer, refuse a second, and need a description to stop', async () => {
    const { timers, db } = setup();
    db.timeTimer.create.mockRejectedValueOnce(
      Object.assign(new Error('dup'), { code: 'P2002', name: 'PrismaClientKnownRequestError' }),
    );
    await expect(timers.start({ fileId: FILE.id })).rejects.toMatchObject({ code: 'RES-002' });
    db.timeTimer.create.mockRejectedValueOnce(new Error('down'));
    await expect(timers.start({ fileId: FILE.id })).rejects.toThrow('down');
    await expect(timers.stop({})).rejects.toMatchObject({ code: 'RES-001' });
    const timer = {
      id: ID(5),
      officeId: 'o1',
      fileId: FILE.id,
      description: null,
      startedAt: new Date(),
    };
    db.timeTimer.findFirst.mockResolvedValueOnce(timer);
    await expect(timers.stop({})).rejects.toMatchObject({ code: 'VAL-001' });
    db.timeTimer.findFirst.mockResolvedValueOnce(timer);
    db.timeTimer.deleteMany.mockResolvedValueOnce({ count: 0 });
    await expect(timers.stop({ description: 'Done' })).rejects.toMatchObject({ code: 'RES-001' });
    expect(await timers.timer()).toBeNull();
  });

  it('should sum totals in Decimal and hide amounts without invoice rights', async () => {
    const { entries, db } = setup();
    db.legalFile.findFirstOrThrow.mockResolvedValueOnce({ currency: 'ILS' });
    db.timeEntry.findMany.mockResolvedValueOnce([
      {
        durationHours: new Prisma.Decimal('0.1'),
        hourlyRate: null,
        isBillable: true,
        invoiceId: null,
      },
      {
        durationHours: new Prisma.Decimal('0.2'),
        hourlyRate: null,
        isBillable: false,
        invoiceId: null,
      },
    ]);
    expect(await entries.totals(FILE.id)).toEqual({
      currency: 'ILS',
      billableHours: '0.10',
      nonBillableHours: '0.20',
      unbilledHours: '0.10',
      billableAmount: null,
      unbilledAmount: null,
    });
  });

  it('should start a timer and stop it into an entry on the day it started', async () => {
    const { timers, db } = setup();
    const startedAt = new Date('2026-11-08T21:50:00Z'); // 23:50 in Hebron
    const timer = { id: ID(5), officeId: 'o1', fileId: FILE.id, description: 'Prep', startedAt };
    db.timeTimer.findFirst.mockResolvedValueOnce({
      id: ID(5),
      description: 'Prep',
      startedAt,
      file: FILE,
    });
    expect(await timers.start({ fileId: FILE.id, description: '' })).toMatchObject({ file: FILE });
    expect(db.timeTimer.create.mock.calls[0]?.[0].data.description).toBeNull();
    db.timeTimer.findFirst.mockResolvedValueOnce(timer);
    db.officeSettings.findFirst.mockResolvedValueOnce({
      defaultBillingRate: null,
      timeIncrementMinutes: 15,
    });
    await timers.stop({ isBillable: false }, new Date('2026-11-08T22:01:00Z'));
    expect(db.timeEntry.create.mock.calls[0]?.[0].data).toMatchObject({
      workDate: new Date('2026-11-08T00:00:00Z'),
      durationHours: new Prisma.Decimal('0.25'),
      description: 'Prep',
      isBillable: false,
      hourlyRate: null,
    });
  });

  it('should show invoice holders amounts in totals, a null rate as null, and 404 an unseen entry', async () => {
    const { entries, db } = setup({
      userId: ID(7),
      role: 'SENIOR_LAWYER',
      permissions: ['view:assigned:invoices'],
    } as never);
    db.legalFile.findFirstOrThrow.mockResolvedValueOnce({ currency: 'JOD' });
    db.timeEntry.findMany.mockResolvedValueOnce([
      {
        durationHours: new Prisma.Decimal('1.5'),
        hourlyRate: new Prisma.Decimal('100'),
        isBillable: true,
        invoiceId: ID(9),
      },
      {
        durationHours: new Prisma.Decimal('0.5'),
        hourlyRate: null,
        isBillable: true,
        invoiceId: null,
      },
    ]);
    expect(await entries.totals(FILE.id)).toMatchObject({
      currency: 'JOD',
      billableHours: '2.00',
      unbilledHours: '0.50',
      billableAmount: '150.00',
      unbilledAmount: '0.00',
    });
    db.timeEntry.findFirst.mockResolvedValueOnce(row({ hourlyRate: null }));
    expect(await entries.get(ID(10))).toMatchObject({ hourlyRate: null, amount: null });
    db.timeEntry.findFirst.mockResolvedValueOnce(null);
    await expect(entries.get(ID(10))).rejects.toMatchObject({ code: 'RES-001' });
    await entries.create({
      fileId: FILE.id,
      workDate: '2026-11-01',
      durationHours: '1',
      description: 'Call',
      isBillable: false,
    });
    expect(db.timeEntry.create.mock.calls[0]?.[0].data).toMatchObject({
      workDate: new Date('2026-11-01T00:00:00Z'),
      isBillable: false,
      hourlyRate: null,
    });
    expect(db.office.findFirstOrThrow).not.toHaveBeenCalled();
  });

  it('should refuse to run without a caller', async () => {
    await expect(setup({}).entries.get(ID(10))).rejects.toThrow('No office caller');
  });
});
