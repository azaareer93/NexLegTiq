import type { ClsService } from 'nestjs-cls';

import { syncConflicts } from './conflict-detection';
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
      // The lookup, then the read of the resolved row.
      findFirst: jest.fn().mockResolvedValueOnce(found).mockResolvedValue(row()),
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
    const page = await setup().service.list({ page: 1, limit: 20, resolved: 'false', fileId: 'b' });
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

  it('should show a resolved conflict with its note only to readers of both files', async () => {
    const { service, db, access } = setup({ visible: ['a', 'b'] });
    const resolved = row({
      resolved: true,
      resolutionNotes: 'Consented',
      resolvedAt: new Date('2026-10-24T10:00:00Z'),
      party: { id: 'p1', fullName: 'Omar', companyName: null },
    });
    db.conflictOfInterest.findMany.mockResolvedValue([resolved]);
    const page = await service.list({ page: 1, limit: 20 });
    expect(access.assertFileAccess).not.toHaveBeenCalled();
    expect(page.items[0]).toMatchObject({
      party: { name: 'Omar' },
      resolutionNotes: 'Consented',
      resolvedAt: '2026-10-24T10:00:00.000Z',
    });
    expect(db.conflictOfInterest.findMany.mock.calls[0]?.[0].where).not.toHaveProperty('resolved');
    expect(await service.openFor('a', 'p1')).toHaveLength(1);
  });

  it('should pass on errors that are not access refusals', async () => {
    const { service, access } = setup();
    access.assertFileAccess.mockRejectedValueOnce(new Error('db down'));
    await expect(service.resolve('c1', 'x', client)).rejects.toThrow('db down');
    access.assertFileAccess.mockRejectedValue(new AppException('BIZ-007', 'archived'));
    await expect(service.resolve('c1', 'x', client)).rejects.toMatchObject({ code: 'BIZ-007' });
  });
});

describe('syncConflicts (D-135)', () => {
  function tx({
    roles = [] as { fileId: string; partyType: string }[],
    clients = [] as string[],
    existing = [] as object[],
  } = {}) {
    return {
      fileParty: { findMany: jest.fn().mockResolvedValue(roles) },
      $queryRaw: jest.fn().mockResolvedValue(clients.map((file_id) => ({ file_id }))),
      conflictOfInterest: {
        findMany: jest.fn().mockResolvedValue(existing),
        createMany: jest.fn(),
        deleteMany: jest.fn(),
      },
    };
  }
  const party = { id: 'p1', name: 'Omar', nationalIdIndex: 'n', taxIdIndex: null };
  const run = (t: ReturnType<typeof tx>) =>
    syncConflicts(t as unknown as ScopedTransaction, 'o1', 'f', party);
  const created = (t: ReturnType<typeof tx>) =>
    (t.conflictOfInterest.createMany.mock.calls[0]?.[0] as { data: object[] } | undefined)?.data ??
    [];

  it('should flag a pair when either role is a dispute side, whichever came first', async () => {
    const witnessFirst = tx({
      roles: [
        { fileId: 'f', partyType: 'DEFENDANT' },
        { fileId: 'g', partyType: 'THIRD_PARTY' },
      ],
    });
    await run(witnessFirst);
    expect(created(witnessFirst)).toEqual([
      expect.objectContaining({ fileIdB: 'g', reason: 'ADVERSE_ON_OTHER_FILE' }),
    ]);
    const neutral = tx({
      roles: [
        { fileId: 'f', partyType: 'GUARANTOR' },
        { fileId: 'g', partyType: 'THIRD_PARTY' },
      ],
    });
    await run(neutral);
    expect(neutral.conflictOfInterest.createMany).not.toHaveBeenCalled();
  });

  it('should flag the client of another file when adverse here, and an adverse role elsewhere when the client here', async () => {
    const adverse = tx({ roles: [{ fileId: 'f', partyType: 'PLAINTIFF' }], clients: ['g'] });
    await run(adverse);
    expect(created(adverse)).toEqual([
      expect.objectContaining({ fileIdB: 'g', reason: 'CLIENT_ON_OTHER_FILE' }),
    ]);
    const clientHere = tx({
      roles: [
        { fileId: 'f', partyType: 'THIRD_PARTY' },
        { fileId: 'g', partyType: 'DEFENDANT' },
      ],
      clients: ['f'],
    });
    await run(clientHere);
    expect(created(clientHere)).toEqual([
      expect.objectContaining({ fileIdB: 'g', reason: 'CLIENT_ON_OTHER_FILE' }),
    ]);
  });

  it('should withdraw open conflicts that no longer hold, keep resolved ones, and not record a pair twice', async () => {
    const t = tx({
      roles: [{ fileId: 'g', partyType: 'DEFENDANT' }],
      existing: [
        { id: 'c1', fileIdA: 'g', fileIdB: 'f', resolved: false },
        { id: 'c2', fileIdA: 'f', fileIdB: 'h', resolved: true },
      ],
    });
    await expect(run(t)).resolves.toEqual([{ id: 'c1', otherFileId: 'g' }]);
    expect(t.conflictOfInterest.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['c1'] } } });

    const known = tx({
      roles: [
        { fileId: 'f', partyType: 'DEFENDANT' },
        { fileId: 'g', partyType: 'DEFENDANT' },
      ],
      existing: [{ id: 'c1', fileIdA: 'g', fileIdB: 'f', resolved: true }],
    });
    await expect(run(known)).resolves.toEqual([]);
    expect(known.conflictOfInterest.createMany).not.toHaveBeenCalled();
  });
});
