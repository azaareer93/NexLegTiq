import { Injectable } from '@nestjs/common';
import type {
  AddFilePartyRequest,
  AddFilePartyResult,
  FileParty,
  UpdateFilePartyRequest,
} from '@nexlegtiq/shared-contracts';
import type { PartyType } from '@nexlegtiq/shared-types';

import { detectConflicts } from './conflict-detection';
import { ConflictsService } from './conflicts.service';
import {
  conflictParty,
  FILE_PARTY_SELECT,
  nameOf,
  PARTY_SELECT,
  PartyRegistry,
} from './party-registry';
import { changes } from '../../common/audit/changes';
import { ResourceNotFoundException, ValidationException } from '../../common/errors/app.exception';
import { PrismaService } from '../../database/prisma.service';
import { UnitOfWork } from '../../database/unit-of-work';
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
      await detectConflicts(tx, officeId, fileId, conflictParty(party), input.partyType);
      return row.id;
    });
    const fileParty = await this.get(fileId, id);
    return { fileParty, conflicts: await this.conflicts.openFor(fileId, fileParty.party.id) };
  }

  /** Type and role label; a new type runs the conflict check again. */
  async update(
    fileId: string,
    filePartyId: string,
    input: UpdateFilePartyRequest,
    client: ClientInfo,
  ): Promise<AddFilePartyResult> {
    await this.access.assertFileAccess(fileId, 'write');
    const officeId = this.registry.officeId();
    const partyId = await this.uow.run(async (tx) => {
      const before = await tx.fileParty.findFirst({
        where: { id: filePartyId, fileId },
        select: { partyType: true, roleLabel: true, party: { select: PARTY_SELECT } },
      });
      if (!before) throw new ResourceNotFoundException();
      const { old, next } = changes(before, { ...input });
      if (Object.keys(next).length === 0) return before.party.id;
      await tx.fileParty.update({ where: { id: filePartyId }, data: next });
      await tx.auditLog.create({
        data: this.registry.audit(client, 'FileParty', filePartyId, 'UPDATE', old, next),
      });
      const partyType = (next['partyType'] as PartyType | undefined) ?? before.partyType;
      if (next['partyType'])
        await detectConflicts(tx, officeId, fileId, conflictParty(before.party), partyType);
      return before.party.id;
    });
    return {
      fileParty: await this.get(fileId, filePartyId),
      conflicts: await this.conflicts.openFor(fileId, partyId),
    };
  }

  /**
   * Takes the party off the file (the party stays in the registry). Open conflicts of that party on this file go too
   * once the party has no other role on it; resolved ones stay as history.
   */
  async remove(fileId: string, filePartyId: string, client: ClientInfo): Promise<void> {
    await this.access.assertFileAccess(fileId, 'write');
    await this.uow.run(async (tx) => {
      const row = await tx.fileParty.findFirst({
        where: { id: filePartyId, fileId },
        select: { partyId: true, partyType: true },
      });
      if (!row) throw new ResourceNotFoundException();
      await tx.fileParty.delete({ where: { id: filePartyId } });
      const stillOnFile = await tx.fileParty.count({ where: { fileId, partyId: row.partyId } });
      if (stillOnFile === 0) {
        await tx.conflictOfInterest.deleteMany({
          where: {
            partyId: row.partyId,
            resolved: false,
            OR: [{ fileIdA: fileId }, { fileIdB: fileId }],
          },
        });
      }
      await tx.auditLog.create({
        data: this.registry.audit(
          client,
          'FileParty',
          filePartyId,
          'DELETE',
          { ...row, fileId },
          null,
        ),
      });
    });
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
