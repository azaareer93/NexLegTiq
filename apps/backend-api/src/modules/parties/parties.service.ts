import { Injectable } from '@nestjs/common';
import type {
  AddFilePartyRequest,
  AddFilePartyResult,
  FileParty,
  UpdateFilePartyRequest,
} from '@nexlegtiq/shared-contracts';

import { syncConflicts } from './conflict-detection';
import { ConflictsService } from './conflicts.service';
import {
  conflictParty,
  FILE_PARTY_SELECT,
  nameOf,
  PARTY_SELECT,
  PartyRegistry,
} from './party-registry';
import type { PartyRow } from './party-registry';
import { changes } from '../../common/audit/changes';
import {
  BusinessRuleException,
  ResourceNotFoundException,
  ValidationException,
} from '../../common/errors/app.exception';
import { PrismaService } from '../../database/prisma.service';
import { UnitOfWork } from '../../database/unit-of-work';
import type { ScopedTransaction } from '../../database/unit-of-work';
import type { ClientInfo } from '../auth/client-info';
import { CaseAccessService } from '../legal-files/case-access.service';

/**
 * The parties of a file (MVP-62, W9, D-030, D-135): add an existing or new party, retype, remove. Adding or retyping runs
 * the conflict check in the same transaction; the registry (search, encryption) is PartyRegistry.
 */
@Injectable()
export class PartiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly uow: UnitOfWork,
    private readonly registry: PartyRegistry,
    private readonly access: CaseAccessService,
    private readonly conflicts: ConflictsService,
  ) {}

  async listForFile(fileId: string): Promise<FileParty[]> {
    await this.access.assertFileAccess(fileId, 'read');
    const rows = await this.prisma.db.fileParty.findMany({
      where: { fileId },
      select: FILE_PARTY_SELECT,
      orderBy: [{ joinedAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map((row) => this.registry.present(row));
  }

  async add(
    fileId: string,
    input: AddFilePartyRequest,
    client: ClientInfo,
  ): Promise<AddFilePartyResult> {
    await this.access.assertFileAccess(fileId, 'write');
    const officeId = this.registry.officeId();
    const id = await this.uow.run(async (tx) => {
      await this.lockFile(tx, fileId);
      if (input.partyId) await this.lockParty(tx, input.partyId);
      const party = input.party
        ? await this.registry.create(tx, input.party, client)
        : await tx.party.findFirst({ where: { id: input.partyId }, select: PARTY_SELECT });
      if (!party)
        throw new ValidationException([{ field: 'partyId', message: 'validation.unknownParty' }]);
      const row = await tx.fileParty.create({
        data: {
          officeId,
          fileId,
          partyId: party.id,
          partyType: input.partyType,
          roleLabel: input.roleLabel ?? null,
        },
        select: { id: true },
      });
      await tx.caseTimelineEvent.create({
        data: {
          officeId,
          fileId,
          eventType: 'PARTY_ADDED',
          actorId: this.registry.actorId(),
          sourceType: 'FileParty',
          sourceId: row.id,
          payload: { partyId: party.id, name: nameOf(party), partyType: input.partyType },
        },
      });
      await tx.auditLog.create({
        data: this.registry.audit(client, 'FileParty', row.id, 'CREATE', null, {
          fileId,
          partyId: party.id,
          partyType: input.partyType,
          roleLabel: input.roleLabel ?? null,
        }),
      });
      await this.sync(tx, fileId, party, client);
      return row.id;
    });
    const fileParty = await this.get(fileId, id);
    return { fileParty, conflicts: await this.conflicts.openFor(fileId, fileParty.party.id) };
  }

  /** Type and role label; a new type brings the conflicts in line again. */
  async update(
    fileId: string,
    filePartyId: string,
    input: UpdateFilePartyRequest,
    client: ClientInfo,
  ): Promise<AddFilePartyResult> {
    await this.access.assertFileAccess(fileId, 'write');
    const partyId = await this.uow.run(async (tx) => {
      await this.lockFile(tx, fileId);
      const before = await tx.fileParty.findFirst({
        where: { id: filePartyId, fileId },
        select: { partyType: true, roleLabel: true, party: { select: PARTY_SELECT } },
      });
      if (!before) throw new ResourceNotFoundException();
      const { old, next } = changes(before, { ...input });
      if (Object.keys(next).length === 0) return before.party.id;
      await this.lockParty(tx, before.party.id);
      await tx.fileParty.update({ where: { id: filePartyId }, data: next });
      await tx.auditLog.create({
        data: this.registry.audit(client, 'FileParty', filePartyId, 'UPDATE', old, next),
      });
      if (next['partyType']) await this.sync(tx, fileId, before.party, client);
      return before.party.id;
    });
    return {
      fileParty: await this.get(fileId, filePartyId),
      conflicts: await this.conflicts.openFor(fileId, partyId),
    };
  }

  /**
   * Takes the party off the file (the party stays in the registry). Open conflicts that no longer hold go, with an audit
   * row each; resolved ones stay as history.
   */
  async remove(fileId: string, filePartyId: string, client: ClientInfo): Promise<void> {
    await this.access.assertFileAccess(fileId, 'write');
    await this.uow.run(async (tx) => {
      await this.lockFile(tx, fileId);
      const row = await tx.fileParty.findFirst({
        where: { id: filePartyId, fileId },
        select: { partyId: true, partyType: true, party: { select: PARTY_SELECT } },
      });
      if (!row) throw new ResourceNotFoundException();
      await this.lockParty(tx, row.partyId);
      await tx.fileParty.delete({ where: { id: filePartyId } });
      await this.sync(tx, fileId, row.party, client);
      await tx.auditLog.create({
        data: this.registry.audit(
          client,
          'FileParty',
          filePartyId,
          'DELETE',
          { partyId: row.partyId, partyType: row.partyType, fileId },
          null,
        ),
      });
    });
  }

  /** Conflicts of the party on this file brought in line (D-135); each one taken away is audited. */
  private async sync(
    tx: ScopedTransaction,
    fileId: string,
    party: PartyRow,
    client: ClientInfo,
  ): Promise<void> {
    const withdrawn = await syncConflicts(
      tx,
      this.registry.officeId(),
      fileId,
      conflictParty(party),
    );
    for (const conflict of withdrawn) {
      await tx.auditLog.create({
        data: this.registry.audit(
          client,
          'ConflictOfInterest',
          conflict.id,
          'DELETE',
          {
            fileId,
            otherFileId: conflict.otherFileId,
            partyId: party.id,
          },
          null,
        ),
      });
    }
  }

  /**
   * One writer per party at a time, so two changes about the same party (on two files) see each other and the conflict
   * check never misses a pair (READ COMMITTED would hide the other's uncommitted role).
   */
  private async lockParty(tx: ScopedTransaction, partyId: string): Promise<void> {
    await tx.$queryRaw`SELECT 1 FROM parties WHERE id = ${partyId}::uuid AND office_id = ${this.registry.officeId()}::uuid FOR UPDATE`;
  }

  /** The file, locked and checked again inside the write (D-119, D-126): deleted meanwhile → 404, archived → BIZ-007. */
  private async lockFile(tx: ScopedTransaction, fileId: string): Promise<void> {
    const [file] = await tx.$queryRaw<{ status: string; deleted: boolean }[]>`
      SELECT status::text AS status, deleted_at IS NOT NULL AS deleted FROM legal_files
      WHERE id = ${fileId}::uuid AND office_id = ${this.registry.officeId()}::uuid FOR NO KEY UPDATE`;
    if (!file || file.deleted) throw new ResourceNotFoundException();
    if (file.status === 'ARCHIVED')
      throw new BusinessRuleException('BIZ-007', 'The file is archived and read-only');
  }

  private async get(fileId: string, filePartyId: string): Promise<FileParty> {
    const row = await this.prisma.db.fileParty.findFirst({
      where: { id: filePartyId, fileId },
      select: FILE_PARTY_SELECT,
    });
    if (!row) throw new ResourceNotFoundException();
    return this.registry.present(row);
  }
}
