import { Injectable } from '@nestjs/common';
import type { AddFileClientRequest, FileClient } from '@nexlegtiq/shared-contracts';
import { ClsService } from 'nestjs-cls';

import { lockFile, mayExpose } from './file-lock';
import { AuditService } from '../../common/audit/audit.service';
import type { AuditClient } from '../../common/audit/audit.service';
import type { RequestContext } from '../../common/context/request-context';
import {
  BusinessRuleException,
  PermissionDeniedException,
  ResourceConflictException,
  ResourceNotFoundException,
  ValidationException,
} from '../../common/errors/app.exception';
import { PrismaService } from '../../database/prisma.service';
import { UnitOfWork } from '../../database/unit-of-work';
import type { ScopedTransaction } from '../../database/unit-of-work';
import { CaseAccessService } from '../legal-files/case-access.service';

const CLIENT_SELECT = {
  isPrimary: true,
  client: { select: { id: true, displayName: true, clientType: true } },
} as const;

/**
 * The clients of a file (D-033, D-140): exactly one is primary, and a file always keeps at least one. Reads follow the
 * file's visibility, changes its write access (D-096); every change locks the file row and writes a timeline event (when
 * a client joins or leaves) and an audit row.
 */
@Injectable()
export class FileClientsService {
  constructor(
    private readonly cls: ClsService<RequestContext>,
    private readonly prisma: PrismaService,
    private readonly uow: UnitOfWork,
    private readonly access: CaseAccessService,
    private readonly audit: AuditService,
  ) {}

  async list(fileId: string): Promise<FileClient[]> {
    await this.access.assertFileAccess(fileId, 'read');
    return this.read(this.prisma.db, fileId);
  }

  /** A live, active client of the office (else 400 `validation.unknownClient`); already on the file → 409 RES-002. */
  async add(
    fileId: string,
    input: AddFileClientRequest,
    client: AuditClient,
  ): Promise<FileClient[]> {
    await this.access.assertFileAccess(fileId, 'write');
    await this.uow.run(async (tx) => {
      const file = await lockFile(tx, this.officeId(), fileId);
      // A client linked to a file will see it in the client portal (D-003): on a confidential file, only the people who
      // set confidentiality decide (D-096, D-140).
      if (file.isConfidential && !mayExpose(file, this.cls.get('role'), this.actorId())) {
        throw new PermissionDeniedException();
      }
      const known = await tx.client.count({
        where: { id: input.clientId, deletedAt: null, isActive: true },
      });
      if (known === 0) {
        throw new ValidationException([{ field: 'clientId', message: 'validation.unknownClient' }]);
      }
      if (await tx.fileClient.count({ where: { fileId, clientId: input.clientId } })) {
        throw new ResourceConflictException('RES-002');
      }
      const isPrimary = input.isPrimary ?? false;
      if (isPrimary) await this.demotePrimary(tx, fileId);
      await tx.fileClient.create({
        data: { officeId: this.officeId(), fileId, clientId: input.clientId, isPrimary },
      });
      await this.event(tx, fileId, 'CLIENT_ADDED', { clientId: input.clientId, isPrimary });
      await this.audit.log(
        tx,
        {
          entityType: 'FileClient',
          entityId: fileId,
          action: 'CREATE',
          newValues: { fileId, clientId: input.clientId, isPrimary },
        },
        client,
      );
    });
    return this.read(this.prisma.db, fileId);
  }

  /** Makes a client of the file its primary client; the previous one stays a client. */
  async makePrimary(fileId: string, clientId: string, client: AuditClient): Promise<FileClient[]> {
    await this.access.assertFileAccess(fileId, 'write');
    await this.uow.run(async (tx) => {
      await lockFile(tx, this.officeId(), fileId);
      const row = await tx.fileClient.findFirst({
        where: { fileId, clientId },
        select: { isPrimary: true },
      });
      if (!row) throw new ResourceNotFoundException();
      if (row.isPrimary) return;
      await this.demotePrimary(tx, fileId);
      await tx.fileClient.updateMany({ where: { fileId, clientId }, data: { isPrimary: true } });
      await this.audit.log(
        tx,
        {
          entityType: 'FileClient',
          entityId: fileId,
          action: 'UPDATE',
          oldValues: { clientId, isPrimary: false },
          newValues: { clientId, isPrimary: true },
        },
        client,
      );
    });
    return this.read(this.prisma.db, fileId);
  }

  /** The last client stays (422 BIZ-018); removing the primary makes the oldest remaining client primary. */
  async remove(fileId: string, clientId: string, client: AuditClient): Promise<void> {
    await this.access.assertFileAccess(fileId, 'write');
    await this.uow.run(async (tx) => {
      await lockFile(tx, this.officeId(), fileId);
      const rows = await tx.fileClient.findMany({
        where: { fileId },
        select: { clientId: true, isPrimary: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      const target = rows.find((row) => row.clientId === clientId);
      if (!target) throw new ResourceNotFoundException();
      if (rows.length === 1) {
        throw new BusinessRuleException('BIZ-018', 'The last client of a file cannot be removed');
      }
      await tx.fileClient.deleteMany({ where: { fileId, clientId } });
      const promoted = target.isPrimary ? rows.find((row) => row.clientId !== clientId) : undefined;
      if (promoted) {
        await tx.fileClient.updateMany({
          where: { fileId, clientId: promoted.clientId },
          data: { isPrimary: true },
        });
      }
      await this.event(tx, fileId, 'CLIENT_REMOVED', { clientId });
      await this.audit.log(
        tx,
        {
          entityType: 'FileClient',
          entityId: fileId,
          action: 'DELETE',
          oldValues: { fileId, clientId, isPrimary: target.isPrimary },
          ...(promoted ? { newValues: { promotedClientId: promoted.clientId } } : {}),
        },
        client,
      );
    });
  }

  private async demotePrimary(tx: ScopedTransaction, fileId: string): Promise<void> {
    await tx.fileClient.updateMany({
      where: { fileId, isPrimary: true },
      data: { isPrimary: false },
    });
  }

  private async event(
    tx: ScopedTransaction,
    fileId: string,
    eventType: 'CLIENT_ADDED' | 'CLIENT_REMOVED',
    payload: Record<string, string | boolean>,
  ): Promise<void> {
    await tx.caseTimelineEvent.create({
      data: { officeId: this.officeId(), fileId, eventType, actorId: this.actorId(), payload },
    });
  }

  /** Primary first, then by name; a client deleted later still shows on the files it belongs to. */
  private async read(
    db: Pick<ScopedTransaction, 'fileClient'>,
    fileId: string,
  ): Promise<FileClient[]> {
    const rows = await db.fileClient.findMany({
      where: { fileId },
      select: CLIENT_SELECT,
      orderBy: [{ isPrimary: 'desc' }, { client: { displayName: 'asc' } }],
    });
    return rows.map(({ isPrimary, client }) => ({ ...client, isPrimary }));
  }

  private officeId(): string {
    const officeId = this.cls.get('officeId');
    if (!officeId) throw new Error('No office in the request context');
    return officeId;
  }

  private actorId(): string {
    const userId = this.cls.get('userId');
    if (!userId) throw new Error('No user in the request context');
    return userId;
  }
}
