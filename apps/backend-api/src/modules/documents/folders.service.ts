import { Injectable } from '@nestjs/common';
import type { CreateFolderRequest, Folder, UpdateFolderRequest } from '@nexlegtiq/shared-contracts';
import type { UserId } from '@nexlegtiq/shared-types';
import { ClsService } from 'nestjs-cls';

import { FolderTree, MAX_FOLDER_DEPTH } from './folder-tree';
import type { RequestContext } from '../../common/context/request-context';
import {
  BusinessRuleException,
  ResourceNotFoundException,
  ValidationException,
} from '../../common/errors/app.exception';
import { isPrismaError } from '../../common/errors/prisma-error';
import { PrismaService } from '../../database/prisma.service';
import { UnitOfWork } from '../../database/unit-of-work';
import type { ScopedTransaction } from '../../database/unit-of-work';
import type { Prisma } from '../../generated/prisma/client';
import type { ClientInfo } from '../auth/client-info';
import { truncateUserAgent } from '../auth/client-info';
import { changedFields } from '../clients/client-context';
import { CaseAccessService } from '../legal-files/case-access.service';

const FOLDER_SELECT = {
  id: true,
  fileId: true,
  parentId: true,
  name: true,
  systemKey: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { documents: { where: { deletedAt: null } } } },
} satisfies Prisma.DocumentFolderSelect;

type FolderRow = Prisma.DocumentFolderGetPayload<{ select: typeof FOLDER_SELECT }>;

const toFolder = ({ _count, createdAt, updatedAt, ...row }: FolderRow): Folder => ({
  ...row,
  documentCount: _count.documents,
  createdAt: createdAt.toISOString(),
  updatedAt: updatedAt.toISOString(),
});

const invalid = (field: string, message: string) => new ValidationException([{ field, message }]);

const notEmpty = () => new BusinessRuleException('BIZ-013', 'The folder is not empty');

/** Folders of a file (`cases/:id/folders`, MVP-71, D-119). Access follows the file. */
@Injectable()
export class FoldersService {
  constructor(
    private readonly cls: ClsService<RequestContext>,
    private readonly prisma: PrismaService,
    private readonly uow: UnitOfWork,
    private readonly access: CaseAccessService,
  ) {}

  /** Every folder of the file, system folders first (in their fixed order), then by name; the UI builds the tree. */
  async list(fileId: string): Promise<Folder[]> {
    await this.access.assertFileAccess(fileId, 'read');
    const rows = await this.prisma.db.documentFolder.findMany({
      where: { fileId },
      select: FOLDER_SELECT,
      orderBy: [{ systemKey: { sort: 'asc', nulls: 'last' } }, { name: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toFolder);
  }

  /** A folder at the root or under a folder of the same file; a duplicate sibling name is 409 RES-002. */
  async create(fileId: string, input: CreateFolderRequest, client: ClientInfo): Promise<Folder> {
    await this.access.assertFileAccess(fileId, 'contribute');
    const id = await this.uow.run(async (tx) => {
      const tree = await this.lockTree(tx, fileId);
      const parentId = input.parentId ?? null;
      if (parentId !== null) {
        if (!tree.has(parentId)) throw invalid('parentId', 'validation.unknownFolder');
        if (tree.depth(parentId) + 1 > MAX_FOLDER_DEPTH) {
          throw invalid('parentId', 'validation.folderDepth');
        }
      }
      const folder = await tx.documentFolder.create({
        data: { officeId: this.officeId(), fileId, parentId, name: input.name },
        select: { id: true },
      });
      await tx.auditLog.create({
        data: this.auditRow(client, folder.id, 'CREATE', null, {
          fileId,
          parentId,
          name: input.name,
        }),
      });
      return folder.id;
    });
    return this.get(id);
  }

  /** Renames and/or moves a folder (with its subtree); system folders are fixed (BIZ-014). */
  async update(
    fileId: string,
    folderId: string,
    input: UpdateFolderRequest,
    client: ClientInfo,
  ): Promise<Folder> {
    await this.access.assertFileAccess(fileId, 'contribute');
    await this.uow.run(async (tx) => {
      const tree = await this.lockTree(tx, fileId);
      const before = await this.customFolder(tx, fileId, folderId);
      if (input.parentId !== undefined && input.parentId !== before.parentId) {
        this.assertMove(tree, folderId, input.parentId);
      }
      const { old, next } = changedFields(before, input);
      if (Object.keys(next).length === 0) return;
      await tx.documentFolder.update({ where: { id: folderId }, data: next });
      await tx.auditLog.create({ data: this.auditRow(client, folderId, 'UPDATE', old, next) });
    });
    return this.get(folderId);
  }

  /**
   * Deletes an empty custom folder (BIZ-013 while it has subfolders or live documents). Its soft-deleted documents
   * move to the file's root, so they never block the delete.
   */
  async remove(fileId: string, folderId: string, client: ClientInfo): Promise<void> {
    await this.access.assertFileAccess(fileId, 'contribute');
    await this.uow.run(async (tx) => {
      await this.lockTree(tx, fileId);
      const before = await this.customFolder(tx, fileId, folderId);
      const [children, documents] = await Promise.all([
        tx.documentFolder.count({ where: { parentId: folderId } }),
        tx.document.count({ where: { folderId, deletedAt: null } }),
      ]);
      if (children > 0 || documents > 0) throw notEmpty();
      await tx.document.updateMany({ where: { folderId }, data: { folderId: null } });
      // A document uploaded into the folder meanwhile makes the foreign key refuse the delete.
      await tx.documentFolder.delete({ where: { id: folderId } }).catch((error: unknown) => {
        if (isPrismaError(error) && error.code === 'P2003') throw notEmpty();
        throw error;
      });
      await tx.auditLog.create({
        data: this.auditRow(
          client,
          folderId,
          'DELETE',
          { name: before.name, parentId: before.parentId },
          null,
        ),
      });
    });
  }

  private async get(id: string): Promise<Folder> {
    return toFolder(
      await this.prisma.db.documentFolder.findUniqueOrThrow({
        where: { id },
        select: FOLDER_SELECT,
      }),
    );
  }

  /**
   * Locks the file against concurrent folder changes until the transaction ends, then reads its tree. `FOR NO KEY
   * UPDATE` does not block inserts that reference the file (sessions, tasks, documents take KEY SHARE locks).
   */
  private async lockTree(tx: ScopedTransaction, fileId: string): Promise<FolderTree> {
    await tx.$queryRaw`
      SELECT id FROM legal_files
      WHERE id = ${fileId}::uuid AND office_id = ${this.officeId()}::uuid
      FOR NO KEY UPDATE`;
    return new FolderTree(
      await tx.documentFolder.findMany({ where: { fileId }, select: { id: true, parentId: true } }),
    );
  }

  /** A folder of the file that is not a system folder; 404 for another file's (or office's) folder. */
  private async customFolder(tx: ScopedTransaction, fileId: string, folderId: string) {
    const folder = await tx.documentFolder.findFirst({
      where: { id: folderId, fileId },
      select: { name: true, parentId: true, systemKey: true },
    });
    if (!folder) throw new ResourceNotFoundException();
    if (folder.systemKey) {
      throw new BusinessRuleException('BIZ-014', 'Default folders cannot be changed');
    }
    return { name: folder.name, parentId: folder.parentId };
  }

  private assertMove(tree: FolderTree, folderId: string, parentId: string | null): void {
    if (parentId === null) return; // to the root: the subtree only gets shallower
    if (!tree.has(parentId)) throw invalid('parentId', 'validation.unknownFolder');
    if (tree.isWithin(parentId, folderId)) throw invalid('parentId', 'validation.folderMove');
    if (tree.depth(parentId) + tree.height(folderId) > MAX_FOLDER_DEPTH) {
      throw invalid('parentId', 'validation.folderDepth');
    }
  }

  private auditRow(
    caller: ClientInfo,
    entityId: string,
    action: 'CREATE' | 'UPDATE' | 'DELETE',
    oldValues: Record<string, unknown> | null,
    newValues: Record<string, unknown> | null,
  ) {
    return {
      officeId: this.officeId(),
      userId: this.actorId(),
      entityType: 'DocumentFolder',
      entityId,
      action,
      ...(oldValues && { oldValues: JSON.parse(JSON.stringify(oldValues)) as object }),
      ...(newValues && { newValues: JSON.parse(JSON.stringify(newValues)) as object }),
      ipAddress: caller.ip,
      userAgent: truncateUserAgent(caller.userAgent),
      requestId: caller.requestId,
    };
  }

  // A missing caller or office is a programming error (guarded routes always set them): 500 SYS-001.
  private officeId(): string {
    const officeId = this.cls.get('officeId');
    if (!officeId) throw new Error('No office in the request context');
    return officeId;
  }

  private actorId(): UserId {
    const userId = this.cls.get('userId');
    if (!userId) throw new Error('No caller in the request context');
    return userId;
  }
}
