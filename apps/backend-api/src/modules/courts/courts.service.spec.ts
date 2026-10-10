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
  it('should list with filters and search, flagging platform rows', async () => {
    const { db, courts } = setup();
    db.court.findMany.mockResolvedValue([court(null), court(OFFICE, { id: 'c2' })]);
    db.court.count.mockResolvedValue(2);
    const page = await courts.list({
      jurisdiction: 'PALESTINE',
      courtType: 'MAGISTRATE',
      search: 'رام',
      page: 2,
      limit: 10,
    });
    expect(page.items.map((row) => row.isPlatform)).toEqual([true, false]);
    expect(page.pagination).toMatchObject({ page: 2, total: 2 });
    const args = db.court.findMany.mock.calls[0]?.[0] as { where: Record<string, unknown> };
    expect(args).toMatchObject({ skip: 10, take: 10 });
    expect(Object.keys(args.where).sort()).toEqual(['OR', 'courtType', 'jurisdiction']);
    await courts.list({ page: 1, limit: 50 });
    expect(db.court.findMany.mock.calls[1]?.[0]).toMatchObject({ where: {} });
  });

  it('should 404 an unknown court', async () => {
    const { db, courts } = setup();
    db.court.findFirst.mockResolvedValue(null);
    await expect(courts.get('x')).rejects.toBeInstanceOf(ResourceNotFoundException);
  });

  it('should create in the office jurisdiction unless one is given, with an audit row', async () => {
    const { db, courts } = setup();
    db.court.create.mockResolvedValue(court(OFFICE));
    await courts.create({ courtType: 'MAGISTRATE', nameAr: 'م' }, CALLER);
    expect(db.court.create.mock.calls[0]?.[0]).toMatchObject({
      data: { jurisdiction: 'JORDAN', officeId: OFFICE },
    });
    await courts.create({ courtType: 'MAGISTRATE', nameAr: 'م', jurisdiction: 'EGYPT' }, CALLER);
    expect(db.court.create.mock.calls[1]?.[0]).toMatchObject({ data: { jurisdiction: 'EGYPT' } });
    expect(db.office.findFirstOrThrow).toHaveBeenCalledTimes(1);
    expect(db.auditLog.create).toHaveBeenCalledTimes(2);
  });

  it('should refuse to change a platform court, and write only real changes', async () => {
    const { db, courts } = setup();
    db.court.findFirst.mockResolvedValue(court(null));
    await expect(courts.update('c1', { city: 'x' }, CALLER)).rejects.toBeInstanceOf(
      PermissionDeniedException,
    );
    await expect(courts.remove('c1', CALLER)).rejects.toBeInstanceOf(PermissionDeniedException);
    db.court.findFirst.mockResolvedValue(court(OFFICE));
    await courts.update('c1', { city: 'رام الله' }, CALLER);
    expect(db.court.updateMany).not.toHaveBeenCalled();
    await courts.update('c1', { city: 'نابلس' }, CALLER);
    expect(db.court.updateMany).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { city: 'نابلس' },
    });
    expect(db.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it('should delete an office court, 422 BIZ-011 while referenced, other errors untouched', async () => {
    const { db, courts } = setup();
    db.court.findFirst.mockResolvedValue(court(OFFICE));
    await courts.remove('c1', CALLER);
    expect(db.auditLog.create).toHaveBeenCalledTimes(1);
    db.court.deleteMany.mockRejectedValueOnce(foreignKeyError());
    await expect(courts.remove('c1', CALLER)).rejects.toBeInstanceOf(BusinessRuleException);
    db.court.deleteMany.mockRejectedValueOnce(new Error('boom'));
    await expect(courts.remove('c1', CALLER)).rejects.toThrow('boom');
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
