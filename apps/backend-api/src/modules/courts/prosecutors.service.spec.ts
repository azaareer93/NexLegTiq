import { ProsecutorsService } from './prosecutors.service';
import type { ReferenceContext } from './reference-context';
import type { PrismaService } from '../../database/prisma.service';
import type { UnitOfWork } from '../../database/unit-of-work';
import type { ClientInfo } from '../auth/client-info';

const AT = new Date('2026-11-08T10:00:00.000Z');
const ROW = {
  id: 'p1',
  fullName: 'Prosecutor Hani',
  officeName: 'Ramallah prosecution',
  phone: null,
  email: null,
  notes: null,
  createdAt: AT,
  updatedAt: AT,
};
const CALLER = { ip: null, userAgent: null } as unknown as ClientInfo;

function setup(row: typeof ROW | null = ROW, deleted = 1) {
  const publicProsecutor = {
    findMany: jest.fn().mockResolvedValue(row ? [row] : []),
    count: jest.fn().mockResolvedValue(row ? 1 : 0),
    findFirst: jest.fn().mockResolvedValue(row),
    create: jest.fn().mockResolvedValue(ROW),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    deleteMany: jest.fn().mockResolvedValue({ count: deleted }),
  };
  const tx = { publicProsecutor, auditLog: { create: jest.fn() } };
  const ctx = { officeId: () => 'o1', auditRow: jest.fn(() => ({})) };
  const service = new ProsecutorsService(
    ctx as unknown as ReferenceContext,
    { run: (work: (t: typeof tx) => unknown) => work(tx) } as unknown as UnitOfWork,
    { db: { publicProsecutor } } as unknown as PrismaService,
  );
  return { service, tx, publicProsecutor };
}

describe('ProsecutorsService (D-115)', () => {
  it('should search by name or office only when asked', async () => {
    const { service, publicProsecutor } = setup();
    await service.list({ search: 'Hani', page: 1, limit: 20 } as never);
    expect(publicProsecutor.findMany.mock.calls[0]?.[0].where).toEqual({
      OR: [
        { fullName: { contains: 'Hani', mode: 'insensitive' } },
        { officeName: { contains: 'Hani', mode: 'insensitive' } },
      ],
    });
    await expect(service.list({ page: 2, limit: 20 } as never)).resolves.toMatchObject({
      items: [{ id: 'p1', createdAt: AT.toISOString() }],
    });
    expect(publicProsecutor.findMany.mock.calls[1]?.[0]).toMatchObject({ where: {}, skip: 20 });
  });

  it('should write and audit an update only when something changes', async () => {
    const same = setup();
    await same.service.update('p1', { fullName: ROW.fullName }, CALLER);
    expect(same.publicProsecutor.updateMany).not.toHaveBeenCalled();
    const changed = setup();
    await changed.service.update('p1', { fullName: 'Prosecutor Rami' }, CALLER);
    expect(changed.publicProsecutor.updateMany).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: { fullName: 'Prosecutor Rami' },
    });
    expect(changed.tx.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it('should answer 404 for a prosecutor that is not the office’s or was deleted meanwhile', async () => {
    await expect(setup(null).service.get('p1')).rejects.toMatchObject({ code: 'RES-001' });
    await expect(setup(ROW, 0).service.remove('p1', CALLER)).rejects.toMatchObject({
      code: 'RES-001',
    });
    const { service, tx } = setup();
    await service.remove('p1', CALLER);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
  });
});
