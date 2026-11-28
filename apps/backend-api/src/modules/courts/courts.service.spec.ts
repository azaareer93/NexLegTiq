import type { ClsService } from 'nestjs-cls';

import { CourtsService } from './courts.service';
import { ProsecutorsService } from './prosecutors.service';
import { ReferenceContext } from './reference-context';
import type { RequestContext } from '../../common/context/request-context';
import {
  BusinessRuleException,
  PermissionDeniedException,
  ResourceNotFoundException,
} from '../../common/errors/app.exception';
import type { PrismaService } from '../../database/prisma.service';
import type { UnitOfWork } from '../../database/unit-of-work';

const OFFICE = 'office-1';
const CALLER = { ip: '127.0.0.1', userAgent: 'jest', requestId: 'req-12345678' };
const NOW = new Date('2026-10-10T10:00:00Z');
const cls = {
  get: (key: string) => ({ officeId: OFFICE, userId: 'user-1' })[key],
} as unknown as ClsService<RequestContext>;

const court = (officeId: string | null, overrides: Record<string, unknown> = {}) => ({
  id: 'c1',
  officeId,
  jurisdiction: 'PALESTINE',
  courtType: 'MAGISTRATE',
  nameAr: 'محكمة صلح رام الله',
  nameEn: null,
  city: 'رام الله',
  address: null,
  phone: null,
  email: null,
  isActive: true,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});
const judge = (officeId: string | null, overrides: Record<string, unknown> = {}) => ({
  id: 'j1',
  officeId,
  courtId: 'c1',
  fullName: 'القاضي',
  isActive: true,
  notes: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});
const prosecutor = (overrides: Record<string, unknown> = {}) => ({
  id: 'p1',
  fullName: 'وكيل النيابة',
  officeName: null,
  phone: null,
  email: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});
const delegate = () => ({
  findMany: jest.fn().mockResolvedValue([]),
  findFirst: jest.fn(),
  count: jest.fn().mockResolvedValue(0),
  create: jest.fn(),
  updateMany: jest.fn().mockResolvedValue({ count: 1 }),
  deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
});
const foreignKeyError = () =>
  Object.assign(
    Object.defineProperty(new Error('fk'), 'name', { value: 'PrismaClientKnownRequestError' }),
    { code: 'P2003' },
  );

function setup() {
  const db = {
    court: delegate(),
    judge: delegate(),
    publicProsecutor: delegate(),
    office: { findFirstOrThrow: jest.fn().mockResolvedValue({ jurisdiction: 'JORDAN' }) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const uow = {
    run: (work: (tx: typeof db) => Promise<unknown>) => work(db),
  } as unknown as UnitOfWork;
  const prisma = { db } as unknown as PrismaService;
  const ctx = new ReferenceContext(cls);
  return {
    db,
    courts: new CourtsService(ctx, uow, prisma),
    prosecutors: new ProsecutorsService(ctx, uow, prisma),
  };
}

describe('CourtsService', () => {
  it("should list the active platform courts of the office's country, with filters and search", async () => {
    const { db, courts } = setup();
    db.court.findMany.mockResolvedValue([court(null)]);
    db.court.count.mockResolvedValue(1);
    const page = await courts.list({ courtType: 'MAGISTRATE', search: 'رام', page: 2, limit: 10 });
    expect(page.items.map((row) => [row.isPlatform, row.isActive])).toEqual([[true, true]]);
    expect(page.pagination).toMatchObject({ page: 2, total: 1 });
    const args = db.court.findMany.mock.calls[0]?.[0] as { where: Record<string, unknown> };
    expect(args).toMatchObject({
      skip: 10,
      take: 10,
      where: { officeId: null, isActive: true, jurisdiction: 'JORDAN' },
    });
    expect(Object.keys(args.where).sort()).toEqual([
      'OR',
      'courtType',
      'isActive',
      'jurisdiction',
      'officeId',
    ]);
    await courts.list({ page: 1, limit: 50 });
    expect(db.court.findMany.mock.calls[1]?.[0]).toMatchObject({
      where: { officeId: null, isActive: true, jurisdiction: 'JORDAN' },
    });
  });

  it('should get a court the office sees (also a legacy office court) and 404 an unknown one', async () => {
    const { db, courts } = setup();
    db.court.findFirst.mockResolvedValue(court(OFFICE));
    expect((await courts.get('c1')).isPlatform).toBe(false);
    db.court.findFirst.mockResolvedValue(null);
    await expect(courts.get('x')).rejects.toBeInstanceOf(ResourceNotFoundException);
  });

  it('should list, add, edit and delete judges of a visible court', async () => {
    const { db, courts } = setup();
    db.court.findFirst.mockResolvedValue(court(null));
    db.judge.findMany.mockResolvedValue([judge(null), judge(OFFICE, { id: 'j2' })]);
    expect((await courts.listJudges('c1')).map((row) => row.isPlatform)).toEqual([true, false]);
    db.judge.create.mockResolvedValue(judge(OFFICE));
    await courts.createJudge('c1', { fullName: 'ق' }, CALLER);
    expect(db.judge.create.mock.calls[0]?.[0]).toMatchObject({
      data: { courtId: 'c1', officeId: OFFICE },
    });
    db.judge.findFirst.mockResolvedValue(judge(null));
    await expect(
      courts.updateJudge('c1', 'j1', { isActive: false }, CALLER),
    ).rejects.toBeInstanceOf(PermissionDeniedException);
    await expect(courts.removeJudge('c1', 'j1', CALLER)).rejects.toBeInstanceOf(
      PermissionDeniedException,
    );
    db.judge.findFirst.mockResolvedValue(judge(OFFICE));
    await courts.updateJudge('c1', 'j1', { isActive: true }, CALLER);
    expect(db.judge.updateMany).not.toHaveBeenCalled();
    await courts.updateJudge('c1', 'j1', { isActive: false }, CALLER);
    expect(db.judge.updateMany).toHaveBeenCalledTimes(1);
    db.judge.deleteMany.mockRejectedValueOnce(foreignKeyError());
    await expect(courts.removeJudge('c1', 'j1', CALLER)).rejects.toBeInstanceOf(
      BusinessRuleException,
    );
    await courts.removeJudge('c1', 'j1', CALLER);
    db.judge.findFirst.mockResolvedValue(null);
    await expect(courts.removeJudge('c1', 'jX', CALLER)).rejects.toBeInstanceOf(
      ResourceNotFoundException,
    );
  });
});

describe('ProsecutorsService', () => {
  it('should list with and without a search', async () => {
    const { db, prosecutors } = setup();
    db.publicProsecutor.findMany.mockResolvedValue([prosecutor()]);
    db.publicProsecutor.count.mockResolvedValue(1);
    expect((await prosecutors.list({ search: 'و', page: 1, limit: 50 })).items).toHaveLength(1);
    expect(db.publicProsecutor.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { OR: expect.any(Array) as unknown },
    });
    await prosecutors.list({ page: 1, limit: 50 });
    expect(db.publicProsecutor.findMany.mock.calls[1]?.[0]).toMatchObject({ where: {} });
  });

  it('should create, get, edit, delete and 404 an unknown prosecutor', async () => {
    const { db, prosecutors } = setup();
    db.publicProsecutor.create.mockResolvedValue(prosecutor());
    await prosecutors.create({ fullName: 'و' }, CALLER);
    db.publicProsecutor.findFirst.mockResolvedValue(prosecutor());
    expect((await prosecutors.get('p1')).fullName).toBe('وكيل النيابة');
    await prosecutors.update('p1', { fullName: 'وكيل النيابة' }, CALLER);
    expect(db.publicProsecutor.updateMany).not.toHaveBeenCalled();
    await prosecutors.update('p1', { officeName: 'نيابة نابلس' }, CALLER);
    expect(db.publicProsecutor.updateMany).toHaveBeenCalledTimes(1);
    await prosecutors.remove('p1', CALLER);
    expect(db.auditLog.create).toHaveBeenCalledTimes(3);
    db.publicProsecutor.findFirst.mockResolvedValue(null);
    await expect(prosecutors.get('x')).rejects.toBeInstanceOf(ResourceNotFoundException);
  });

  it('should fail loudly without a caller in the context', async () => {
    const empty = { get: () => undefined } as unknown as ClsService<RequestContext>;
    expect(() => new ReferenceContext(empty).officeId()).toThrow('No office');
    const noUser = {
      get: (key: string) => (key === 'officeId' ? OFFICE : undefined),
    } as unknown as ClsService<RequestContext>;
    expect(() =>
      new ReferenceContext(noUser).auditRow(CALLER, 'Court', 'c1', 'CREATE', null, null),
    ).toThrow('No caller');
  });
});
