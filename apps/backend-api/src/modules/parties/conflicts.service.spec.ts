import type { ClsService } from 'nestjs-cls';

import { detectConflicts } from './conflict-detection';
import { ConflictsService } from './conflicts.service';
import type { RequestContext } from '../../common/context/request-context';
import { AppException, ResourceNotFoundException } from '../../common/errors/app.exception';
import type { PrismaService } from '../../database/prisma.service';
import type { ScopedTransaction, UnitOfWork } from '../../database/unit-of-work';
import type { ClientInfo } from '../auth/client-info';
import type { CaseAccessService } from '../legal-files/case-access.service';

const client: ClientInfo = { ip: '127.0.0.1', userAgent: 'jest', requestId: 'req-12345678' };
const file = (id: string) => ({ id, fileNumber: `N-${id}`, title: `T-${id}` });
const row = (extra: object = {}) => ({
  id: 'c1',
  reason: 'ADVERSE_ON_OTHER_FILE',
  detectedAt: new Date('2026-10-23T10:00:00Z'),
  resolved: false,
  resolutionNotes: null,
  resolvedAt: null,
  fileA: file('a'),
  fileB: file('b'),
  party: { id: 'p1', fullName: null, companyName: 'Org' },
  ...extra,
});

function setup({
  found = { fileIdA: 'a', fileIdB: 'b' } as object | null,
  updated = 1,
  visible = ['a'],
} = {}) {
  const db = {
    conflictOfInterest: {
      findMany: jest.fn().mockResolvedValue([row(), row({ id: 'c2', reason: 'LEGACY' })]),
      count: jest.fn().mockResolvedValue(2),
      findFirst: jest.fn().mockResolvedValue(found),
    },
    legalFile: { findMany: jest.fn().mockResolvedValue(visible.map((id) => ({ id }))) },
  };
  const tx = {
    conflictOfInterest: { updateMany: jest.fn().mockResolvedValue({ count: updated }) },
    auditLog: { create: jest.fn() },
  };
  const access = {
    visibleWhere: () => ({}),
    assertFileAccess: jest
      .fn()
      .mockImplementation((id: string) =>
        id === 'a' ? Promise.reject(new ResourceNotFoundException()) : Promise.resolve({ id }),
      ),
  };
  const service = new ConflictsService(
    { db } as unknown as PrismaService,
    { run: (work: (t: typeof tx) => unknown) => work(tx) } as unknown as UnitOfWork,
    {
      get: (key: string) => ({ userId: 'u1', officeId: 'o1' })[key],
    } as unknown as ClsService<RequestContext>,
    access as unknown as CaseAccessService,
  );
  return { service, db, tx, access };
}

describe('ConflictsService (D-135)', () => {
  it('should hide files the reader cannot open and drop unknown reasons', async () => {
    const page = await setup().service.list({ page: 1, limit: 20, resolved: 'false', fileId: 'a' });
    expect(page.items).toEqual([
      expect.objectContaining({
        id: 'c1',
        party: { id: 'p1', name: 'Org' },
        file: file('a'),
        otherFile: null,
      }),
    ]);
    expect(page.pagination.total).toBe(2);
  });

  it('should resolve through the second file when the first is out of reach, and only once', async () => {
    const { service, access, tx } = setup();
    await service.resolve('c1', 'checked', client);
    expect(access.assertFileAccess).toHaveBeenCalledWith('b', 'write');
    expect(tx.auditLog.create).toHaveBeenCalled();
    await expect(setup({ updated: 0 }).service.resolve('c1', 'x', client)).rejects.toMatchObject({
      code: 'BIZ-017',
    });
    await expect(setup({ found: null }).service.resolve('c1', 'x', client)).rejects.toBeInstanceOf(
      ResourceNotFoundException,
    );
  });

  it('should pass on errors that are not access refusals', async () => {
    const { service, access } = setup();
    access.assertFileAccess.mockRejectedValueOnce(new Error('db down'));
    await expect(service.resolve('c1', 'x', client)).rejects.toThrow('db down');
    access.assertFileAccess.mockRejectedValue(new AppException('BIZ-007', 'archived'));
    await expect(service.resolve('c1', 'x', client)).rejects.toMatchObject({ code: 'BIZ-007' });
  });
});

describe('detectConflicts (D-135)', () => {
  function tx({
    adverse = [] as object[],
    clients = [] as object[],
    known = null as object | null,
  } = {}) {
    return {
      fileParty: { findMany: jest.fn().mockResolvedValue(adverse) },
      $queryRaw: jest.fn().mockResolvedValue(clients),
      conflictOfInterest: { findFirst: jest.fn().mockResolvedValue(known), create: jest.fn() },
    };
  }
  const party = { id: 'p1', name: 'Omar', nationalIdIndex: 'n', taxIdIndex: null };

  it('should record each new pair once, check clients only for adverse roles, and skip known pairs', async () => {
    const t = tx({ adverse: [{ fileId: 'g1' }], clients: [{ file_id: 'g2' }] });
    await detectConflicts(t as unknown as ScopedTransaction, 'o1', 'f', party, 'DEFENDANT');
    expect(t.conflictOfInterest.create).toHaveBeenCalledTimes(2);

    const neutral = tx({ clients: [{ file_id: 'g2' }] });
    await detectConflicts(neutral as unknown as ScopedTransaction, 'o1', 'f', party, 'GUARANTOR');
    expect(neutral.$queryRaw).not.toHaveBeenCalled();
    expect(neutral.conflictOfInterest.create).not.toHaveBeenCalled();

    const known = tx({ adverse: [{ fileId: 'g1' }], known: { id: 'c' } });
    await detectConflicts(known as unknown as ScopedTransaction, 'o1', 'f', party, 'THIRD_PARTY');
    expect(known.conflictOfInterest.create).not.toHaveBeenCalled();
  });
});
