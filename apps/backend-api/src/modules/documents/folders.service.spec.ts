import type { ClsService } from 'nestjs-cls';

import { FoldersService } from './folders.service';
import type { RequestContext } from '../../common/context/request-context';
import {
  BusinessRuleException,
  ResourceNotFoundException,
  ValidationException,
} from '../../common/errors/app.exception';
import type { PrismaService } from '../../database/prisma.service';
import type { UnitOfWork } from '../../database/unit-of-work';
import type { CaseAccessService } from '../legal-files/case-access.service';

const OFFICE = '01920000-0000-7000-8000-0000000000aa';
const ME = '01920000-0000-7000-8000-000000000001';
const FILE = '01920000-0000-7000-8000-0000000000f1';
const ROOT = '01920000-0000-7000-8000-0000000000b1';
const CHILD = '01920000-0000-7000-8000-0000000000b2';
const OTHER = '01920000-0000-7000-8000-0000000000b3';
const CLIENT = { ip: '127.0.0.1', userAgent: 'jest', requestId: 'req-12345678' };
const NOW = new Date('2026-10-17T10:00:00Z');

/** A chain ROOT → CHILD, plus OTHER at the root. */
const TREE = [
  { id: ROOT, parentId: null },
  { id: CHILD, parentId: ROOT },
  { id: OTHER, parentId: null },
];

const row = (id: string, overrides: object = {}) => ({
  id,
  fileId: FILE,
  parentId: null,
  name: 'Drafts',
  systemKey: null,
  createdAt: NOW,
  updatedAt: NOW,
  _count: { documents: 0 },
  ...overrides,
});

function setup(
  context: Partial<RequestContext> = { officeId: OFFICE as never, userId: ME as never },
) {
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: FILE }]),
    documentFolder: {
      findMany: jest.fn().mockResolvedValue(TREE),
      findFirst: jest.fn().mockResolvedValue({ name: 'Drafts', parentId: ROOT, systemKey: null }),
      create: jest.fn().mockResolvedValue({ id: OTHER }),
      update: jest.fn(),
      delete: jest.fn().mockResolvedValue({}),
      count: jest.fn().mockResolvedValue(0),
    },
    document: { count: jest.fn().mockResolvedValue(0), updateMany: jest.fn() },
    auditLog: { create: jest.fn() },
  };
  const uow = {
    run: jest.fn((work: (t: typeof tx) => unknown) => work(tx)),
  } as unknown as UnitOfWork;
  const cls = {
    get: (key: keyof RequestContext) => context[key],
  } as unknown as ClsService<RequestContext>;
  const prisma = {
    db: {
      documentFolder: {
        findMany: jest.fn().mockResolvedValue([row(ROOT, { name: null, systemKey: 'PLEADINGS' })]),
        findUniqueOrThrow: jest.fn(({ where }: { where: { id: string } }) =>
          Promise.resolve(row(where.id)),
        ),
      },
    },
  } as unknown as PrismaService;
  const access = { assertFileAccess: jest.fn().mockResolvedValue({ id: FILE }) };
  const service = new FoldersService(cls, prisma, uow, access as unknown as CaseAccessService);
  return { service, tx, access };
}

const prismaError = (code: string) =>
  Object.assign(new Error('fk'), { name: 'PrismaClientKnownRequestError', code });

describe('FoldersService', () => {
  it('should list the file folders with their live document counts after a read check', async () => {
    const { service, access } = setup();
    const folders = await service.list(FILE);
    expect(access.assertFileAccess).toHaveBeenCalledWith(FILE, 'read');
    expect(folders).toEqual([
      expect.objectContaining({
        id: ROOT,
        systemKey: 'PLEADINGS',
        documentCount: 0,
        createdAt: NOW.toISOString(),
      }),
    ]);
  });

  describe('create', () => {
    it('should create a root folder under the file lock with an audit row', async () => {
      const { service, tx, access } = setup();
      const folder = await service.create(FILE, { name: 'Drafts' }, CLIENT);
      expect(access.assertFileAccess).toHaveBeenCalledWith(FILE, 'contribute');
      expect(tx.$queryRaw).toHaveBeenCalled();
      expect(tx.documentFolder.create).toHaveBeenCalledWith({
        data: { officeId: OFFICE, fileId: FILE, parentId: null, name: 'Drafts' },
        select: { id: true },
      });
      expect(tx.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          entityType: 'DocumentFolder',
          action: 'CREATE',
          userId: ME,
        }),
      });
      expect(folder.id).toBe(OTHER);
    });

    it('should create a subfolder of a folder of the same file', async () => {
      const { service, tx } = setup();
      await service.create(FILE, { name: 'Drafts', parentId: CHILD }, CLIENT);
      expect(tx.documentFolder.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ parentId: CHILD }) }),
      );
    });

    it('should refuse a parent that is not a folder of the file', async () => {
      const { service, tx } = setup();
      await expect(
        service.create(FILE, { name: 'X', parentId: FILE }, CLIENT),
      ).rejects.toBeInstanceOf(ValidationException);
      expect(tx.documentFolder.create).not.toHaveBeenCalled();
    });

    it('should refuse a folder past the per-file limit', async () => {
      const { service, tx } = setup();
      tx.documentFolder.findMany.mockResolvedValue(
        Array.from({ length: 200 }, (_, i) => ({ id: `f${i}`, parentId: null })),
      );
      await expect(service.create(FILE, { name: 'X' }, CLIENT)).rejects.toMatchObject({
        details: [{ field: 'name', message: 'validation.folderLimit' }],
      });
    });

    it('should refuse a folder deeper than the limit', async () => {
      const { service, tx } = setup();
      const chain = ['a', 'b', 'c', 'd', 'e'].map((id, i, all) => ({
        id,
        parentId: i === 0 ? null : all[i - 1],
      }));
      tx.documentFolder.findMany.mockResolvedValue(chain);
      await expect(
        service.create(FILE, { name: 'X', parentId: 'e' }, CLIENT),
      ).rejects.toMatchObject({
        details: [{ field: 'parentId', message: 'validation.folderDepth' }],
      });
    });

    it('should fail as a programming error without an office or caller in the context', async () => {
      await expect(setup({}).service.create(FILE, { name: 'X' }, CLIENT)).rejects.toThrow(
        'No office',
      );
      await expect(
        setup({ officeId: OFFICE as never }).service.create(FILE, { name: 'X' }, CLIENT),
      ).rejects.toThrow('No caller');
    });
  });

  describe('update', () => {
    it('should rename and audit only the changed fields', async () => {
      const { service, tx } = setup();
      await service.update(FILE, CHILD, { name: 'Briefs', parentId: ROOT }, CLIENT);
      expect(tx.documentFolder.update).toHaveBeenCalledWith({
        where: { id: CHILD },
        data: { name: 'Briefs' },
      });
      expect(tx.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'UPDATE',
          oldValues: { name: 'Drafts' },
          newValues: { name: 'Briefs' },
        }),
      });
    });

    it('should write nothing when nothing changes', async () => {
      const { service, tx } = setup();
      await service.update(FILE, CHILD, { name: 'Drafts' }, CLIENT);
      expect(tx.documentFolder.update).not.toHaveBeenCalled();
      expect(tx.auditLog.create).not.toHaveBeenCalled();
    });

    it('should move a folder to the root or under another folder', async () => {
      const { service, tx } = setup();
      await service.update(FILE, CHILD, { parentId: null }, CLIENT);
      expect(tx.documentFolder.update).toHaveBeenLastCalledWith({
        where: { id: CHILD },
        data: { parentId: null },
      });
      await service.update(FILE, CHILD, { parentId: OTHER }, CLIENT);
      expect(tx.documentFolder.update).toHaveBeenLastCalledWith({
        where: { id: CHILD },
        data: { parentId: OTHER },
      });
    });

    it('should refuse moves into its own subtree, to an unknown folder or past the depth limit', async () => {
      const { service, tx } = setup();
      tx.documentFolder.findFirst.mockResolvedValue({
        name: 'Root',
        parentId: null,
        systemKey: null,
      });
      await expect(service.update(FILE, ROOT, { parentId: CHILD }, CLIENT)).rejects.toMatchObject({
        details: [{ field: 'parentId', message: 'validation.folderMove' }],
      });
      await expect(service.update(FILE, ROOT, { parentId: FILE }, CLIENT)).rejects.toMatchObject({
        details: [{ field: 'parentId', message: 'validation.unknownFolder' }],
      });
      const chain = ['a', 'b', 'c', 'd', 'e'].map((id, i, all) => ({
        id,
        parentId: i === 0 ? null : all[i - 1],
      }));
      tx.documentFolder.findMany.mockResolvedValue([...TREE, ...chain]);
      await expect(service.update(FILE, ROOT, { parentId: 'd' }, CLIENT)).rejects.toMatchObject({
        details: [{ field: 'parentId', message: 'validation.folderDepth' }],
      });
      expect(tx.documentFolder.update).not.toHaveBeenCalled();
    });

    it('should answer 404 for a folder of another file and BIZ-014 for a system folder', async () => {
      const { service, tx } = setup();
      tx.documentFolder.findFirst.mockResolvedValueOnce(null);
      await expect(service.update(FILE, CHILD, { name: 'X' }, CLIENT)).rejects.toBeInstanceOf(
        ResourceNotFoundException,
      );
      tx.documentFolder.findFirst.mockResolvedValueOnce({
        name: null,
        parentId: null,
        systemKey: 'EVIDENCE',
      });
      await expect(service.update(FILE, ROOT, { name: 'X' }, CLIENT)).rejects.toMatchObject({
        code: 'BIZ-014',
      });
    });
  });

  describe('remove', () => {
    it('should delete an empty folder, detaching its deleted documents, with an audit row', async () => {
      const { service, tx } = setup();
      await service.remove(FILE, CHILD, CLIENT);
      expect(tx.document.updateMany).toHaveBeenCalledWith({
        where: { folderId: CHILD },
        data: { folderId: null },
      });
      expect(tx.documentFolder.delete).toHaveBeenCalledWith({ where: { id: CHILD } });
      expect(tx.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'DELETE',
          oldValues: { name: 'Drafts', parentId: ROOT },
        }),
      });
    });

    it('should refuse a folder with subfolders (BIZ-013)', async () => {
      const { service, tx } = setup();
      await expect(service.remove(FILE, ROOT, CLIENT)).rejects.toMatchObject({ code: 'BIZ-013' });
      expect(tx.documentFolder.delete).not.toHaveBeenCalled();
    });

    it('should refuse a folder with live documents (BIZ-013)', async () => {
      const { service, tx } = setup();
      tx.document.count.mockResolvedValue(1);
      await expect(service.remove(FILE, CHILD, CLIENT)).rejects.toMatchObject({ code: 'BIZ-013' });
      expect(tx.document.count).toHaveBeenCalledWith({
        where: { fileId: FILE, folderId: CHILD, deletedAt: null },
      });
      expect(tx.documentFolder.delete).not.toHaveBeenCalled();
    });

    it('should re-check the file under the lock: gone is 404, archived meanwhile is BIZ-007', async () => {
      const { service, tx } = setup();
      tx.$queryRaw.mockResolvedValueOnce([]);
      await expect(service.remove(FILE, CHILD, CLIENT)).rejects.toBeInstanceOf(
        ResourceNotFoundException,
      );
      tx.$queryRaw.mockResolvedValueOnce([{ status: 'ARCHIVED' }]);
      await expect(service.create(FILE, { name: 'X' }, CLIENT)).rejects.toMatchObject({
        code: 'BIZ-007',
      });
      expect(tx.documentFolder.create).not.toHaveBeenCalled();
    });

    it('should turn a foreign-key refusal (a document uploaded meanwhile) into BIZ-013 and rethrow others', async () => {
      const { service, tx } = setup();
      tx.documentFolder.delete.mockRejectedValueOnce(prismaError('P2003'));
      await expect(service.remove(FILE, CHILD, CLIENT)).rejects.toBeInstanceOf(
        BusinessRuleException,
      );
      const other = prismaError('P2034');
      tx.documentFolder.delete.mockRejectedValueOnce(other);
      await expect(service.remove(FILE, CHILD, CLIENT)).rejects.toBe(other);
      expect(tx.auditLog.create).not.toHaveBeenCalled();
    });
  });
});
