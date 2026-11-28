import { PlatformCourtsService } from './platform-courts.service';
import {
  BusinessRuleException,
  ResourceNotFoundException,
  ValidationException,
} from '../../common/errors/app.exception';
import type { PrismaService } from '../../database/prisma.service';
import type { PlatformAuditService } from '../platform-auth/platform-audit.service';

const NOW = new Date('2026-11-28T10:00:00Z');
const CLIENT = { ip: '127.0.0.1', userAgent: 'jest', requestId: 'req-12345678' };
const OFFICE = 'office-1';

const court = (overrides: Record<string, unknown> = {}) => ({
  id: 'c1',
  officeId: null,
  jurisdiction: 'PALESTINE',
  courtType: 'MAGISTRATE',
  nameAr: 'محكمة صلح رام الله',
  nameEn: 'Ramallah Magistrate Court',
  city: 'رام الله',
  address: null,
  phone: null,
  email: null,
  isActive: true,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

/** Tagged-template SQL as one string, to assert what a raw statement touched. */
const sqlOf = (call: unknown[]) => (call[0] as string[]).join('?');

function setup() {
  const raw = {
    court: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue(court()),
      update: jest.fn().mockResolvedValue(court()),
      delete: jest.fn().mockResolvedValue({}),
    },
    $executeRaw: jest.fn().mockResolvedValue(2),
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
  const db = Object.assign(raw, {
    $transaction: jest.fn((work: (tx: typeof raw) => Promise<unknown>) => work(raw)),
  });
  const prisma = { unscoped: () => db } as unknown as PrismaService;
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const service = new PlatformCourtsService(prisma, audit as unknown as PlatformAuditService);
  return { db, audit, service };
}

describe('PlatformCourtsService', () => {
  it("should list a country's platform courts, inactive included, with filters", async () => {
    const { db, service } = setup();
    db.court.findMany.mockResolvedValue([court({ isActive: false })]);
    db.court.count.mockResolvedValue(1);
    const page = await service.list({
      jurisdiction: 'JORDAN',
      courtType: 'APPEAL',
      search: 'عمان',
      page: 1,
      limit: 20,
    });
    expect(page.items[0]).toMatchObject({ isPlatform: true, isActive: false });
    expect(db.court.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { officeId: null, jurisdiction: 'JORDAN', courtType: 'APPEAL', OR: expect.any(Array) },
    });
    await service.list({ jurisdiction: 'PALESTINE', page: 1, limit: 20 });
    expect(Object.keys(db.court.findMany.mock.calls[1]?.[0].where).sort()).toEqual([
      'jurisdiction',
      'officeId',
    ]);
  });

  it('should create a platform court with an audit row', async () => {
    const { db, audit, service } = setup();
    const body = {
      jurisdiction: 'PALESTINE',
      courtType: 'MAGISTRATE',
      nameAr: 'م',
      nameEn: 'M',
    } as const;
    await service.create(body, 'admin-1', CLIENT);
    expect(db.court.create.mock.calls[0]?.[0]).toMatchObject({ data: body });
    expect(audit.log.mock.calls[0]?.[0]).toMatchObject({
      adminId: 'admin-1',
      action: 'COURT_CREATED',
      entityType: 'Court',
      targetOfficeId: null,
    });
  });

  it('should edit only platform courts and audit real changes only', async () => {
    const { db, audit, service } = setup();
    db.court.findFirst.mockResolvedValueOnce(null);
    await expect(service.update('c2', { isActive: false }, 'a', CLIENT)).rejects.toBeInstanceOf(
      ResourceNotFoundException,
    );
    db.court.findFirst.mockResolvedValue(court());
    await service.update('c1', { isActive: true }, 'a', CLIENT);
    expect(db.court.update).not.toHaveBeenCalled();
    await service.update('c1', { isActive: false, city: 'رام الله' }, 'a', CLIENT);
    expect(db.court.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'c1' }, data: { isActive: false } }),
    );
    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(audit.log.mock.calls[0]?.[0]).toMatchObject({
      action: 'COURT_UPDATED',
      oldValues: { isActive: true },
      newValues: { isActive: false },
    });
  });

  it("should list offices' courts with office name and usage", async () => {
    const { db, service } = setup();
    db.court.findMany.mockResolvedValue([
      {
        ...court({ officeId: OFFICE, nameEn: null }),
        office: { name: 'مكتب' },
        _count: { legalFiles: 3, sessions: 2, judges: 1 },
      },
    ]);
    db.court.count.mockResolvedValue(1);
    const page = await service.listOfficeCourts({ search: 'مكتب', page: 1, limit: 50 });
    expect(page.items[0]).toMatchObject({
      isPlatform: false,
      officeId: OFFICE,
      officeName: 'مكتب',
      fileCount: 3,
      sessionCount: 2,
      judgeCount: 1,
    });
    await service.listOfficeCourts({ page: 1, limit: 50 });
    expect(db.court.findMany.mock.calls[1]?.[0].where).toEqual({ officeId: { not: null } });
  });

  it("should replace an office court: judges first, then that office's files and sessions, then delete", async () => {
    const { db, audit, service } = setup();
    db.court.findFirst
      .mockResolvedValueOnce({
        officeId: OFFICE,
        jurisdiction: 'PALESTINE',
        nameAr: 'م',
        nameEn: null,
      })
      .mockResolvedValueOnce({ id: 'p1' });
    const result = await service.replace('c9', 'p1', 'admin-1', CLIENT);
    expect(result).toEqual({ courtId: 'p1', files: 2, sessions: 2, judges: 2 });
    const statements = db.$executeRaw.mock.calls.map(sqlOf);
    expect(statements[0]).toContain('set_config');
    expect(statements[1]).toContain('UPDATE judges');
    expect(statements[2]).toContain('UPDATE legal_files');
    expect(statements[3]).toContain('UPDATE sessions');
    for (const call of db.$executeRaw.mock.calls.slice(1)) {
      expect(sqlOf(call)).toContain('office_id');
      expect(call).toContain(OFFICE);
    }
    expect(db.court.findFirst.mock.calls[1]?.[0]).toMatchObject({
      where: { id: 'p1', officeId: null, jurisdiction: 'PALESTINE' },
    });
    expect(db.court.delete).toHaveBeenCalledWith({ where: { id: 'c9' } });
    expect(audit.log.mock.calls[0]?.[0]).toMatchObject({
      action: 'OFFICE_COURT_REPLACED',
      targetOfficeId: OFFICE,
    });
  });

  it('should refuse a replace by a court of another country, an unknown office court, or one still referenced', async () => {
    const { db, service } = setup();
    const from = { officeId: OFFICE, jurisdiction: 'PALESTINE', nameAr: 'م', nameEn: null };
    db.court.findFirst.mockResolvedValueOnce(from).mockResolvedValueOnce(null);
    await expect(service.replace('c9', 'p2', 'a', CLIENT)).rejects.toBeInstanceOf(
      ValidationException,
    );
    db.court.findFirst.mockResolvedValueOnce(null);
    await expect(service.replace('c1', 'p1', 'a', CLIENT)).rejects.toBeInstanceOf(
      ResourceNotFoundException,
    );
    db.court.findFirst.mockResolvedValueOnce(from).mockResolvedValueOnce({ id: 'p1' });
    db.court.delete.mockRejectedValueOnce(
      Object.assign(
        Object.defineProperty(new Error('fk'), 'name', { value: 'PrismaClientKnownRequestError' }),
        { code: 'P2003' },
      ),
    );
    await expect(service.replace('c9', 'p1', 'a', CLIENT)).rejects.toBeInstanceOf(
      BusinessRuleException,
    );
  });

  it('should promote an office court, requiring an English name', async () => {
    const { db, audit, service } = setup();
    const from = { officeId: OFFICE, jurisdiction: 'PALESTINE', nameAr: 'م', nameEn: null };
    db.court.findFirst.mockResolvedValueOnce(from);
    await expect(service.promote('c9', {}, 'a', CLIENT)).rejects.toBeInstanceOf(
      ValidationException,
    );
    db.court.findFirst.mockResolvedValueOnce(from);
    await service.promote('c9', { nameEn: 'Jenin Court' }, 'a', CLIENT);
    expect(db.court.update.mock.calls[0]?.[0]).toMatchObject({
      where: { id: 'c9' },
      data: { officeId: null, nameEn: 'Jenin Court' },
    });
    db.court.findFirst.mockResolvedValueOnce({ ...from, nameEn: 'Kept' });
    await service.promote('c9', {}, 'a', CLIENT);
    expect(db.court.update.mock.calls[1]?.[0]).toMatchObject({ data: { nameEn: 'Kept' } });
    expect(audit.log.mock.calls[0]?.[0]).toMatchObject({
      action: 'OFFICE_COURT_PROMOTED',
      targetOfficeId: OFFICE,
    });
  });
});
