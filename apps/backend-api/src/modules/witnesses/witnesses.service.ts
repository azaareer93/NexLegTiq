import { Injectable } from '@nestjs/common';
import type {
  CreateWitnessRequest,
  CreateWitnessStatementRequest,
  UpdateWitnessRequest,
  UpdateWitnessStatementRequest,
  Witness,
  WitnessStatement,
} from '@nexlegtiq/shared-contracts';
import { wallClock } from '@nexlegtiq/shared-utils';
import { ClsService } from 'nestjs-cls';

import {
  LIMIT,
  STATEMENT_SELECT,
  toDbDate,
  toStatement,
  toWitness,
  WITNESS_SELECT,
  withoutText,
} from './witnesses.mapper';
import { AuditService } from '../../common/audit/audit.service';
import { changes } from '../../common/audit/changes';
import type { RequestContext } from '../../common/context/request-context';
import { ResourceNotFoundException, ValidationException } from '../../common/errors/app.exception';
import { PrismaService } from '../../database/prisma.service';
import { UnitOfWork } from '../../database/unit-of-work';
import type { ScopedTransaction } from '../../database/unit-of-work';
import { lockFile } from '../file-participants/file-lock';
import { CaseAccessService } from '../legal-files/case-access.service';
import { TimelineService } from '../timeline/timeline.service';

/**
 * A file's witnesses and their statements (MVP-143, D-163). Access follows the file (D-096): read with a visible file,
 * write with edit rights on a file that is not archived. Internal to the office: no portal route reads them (D-003).
 */
@Injectable()
export class WitnessesService {
  constructor(
    private readonly cls: ClsService<RequestContext>,
    private readonly prisma: PrismaService,
    private readonly uow: UnitOfWork,
    private readonly access: CaseAccessService,
    private readonly timeline: TimelineService,
    private readonly audit: AuditService,
  ) {}

  private caller() {
    const userId = this.cls.get('userId');
    const officeId = this.cls.get('officeId');
    if (!userId || !officeId) throw new Error('No office caller in the request context');
    return { userId, officeId };
  }

  async list(fileId: string): Promise<Witness[]> {
    await this.access.assertFileAccess(fileId, 'read');
    const rows = await this.prisma.db.witness.findMany({
      where: { fileId },
      orderBy: [{ fullName: 'asc' }, { id: 'asc' }],
      take: LIMIT,
      select: WITNESS_SELECT,
    });
    return rows.map(toWitness);
  }

  async create(fileId: string, input: CreateWitnessRequest): Promise<Witness> {
    const { officeId } = this.caller();
    await this.access.assertFileAccess(fileId, 'write');
    return this.uow.run(async (tx) => {
      await lockFile(tx, officeId, fileId);
      const row = await tx.witness.create({
        data: { ...input, officeId, fileId },
        select: WITNESS_SELECT,
      });
      await this.audit.log(tx, {
        entityType: 'Witness',
        entityId: row.id,
        action: 'CREATE',
        newValues: { fileId, fullName: row.fullName, isExpert: row.isExpert },
      });
      return toWitness(row);
    });
  }

  private async witnessIn(tx: ScopedTransaction, fileId: string, witnessId: string) {
    const row = await tx.witness.findFirst({
      where: { id: witnessId, fileId },
      select: WITNESS_SELECT,
    });
    if (!row) throw new ResourceNotFoundException();
    return row;
  }

  async update(fileId: string, witnessId: string, input: UpdateWitnessRequest): Promise<Witness> {
    if (Object.values(input).every((value) => value === undefined)) {
      throw new ValidationException([{ field: 'fullName', message: 'validation.required' }]);
    }
    const { officeId } = this.caller();
    await this.access.assertFileAccess(fileId, 'write');
    return this.uow.run(async (tx) => {
      await lockFile(tx, officeId, fileId);
      const before = await this.witnessIn(tx, fileId, witnessId);
      const { old, next } = changes(before, input);
      if (Object.keys(next).length === 0) return toWitness(before);
      const row = await tx.witness.update({
        where: { id: witnessId },
        data: next,
        select: WITNESS_SELECT,
      });
      await this.audit.log(tx, {
        entityType: 'Witness',
        entityId: witnessId,
        action: 'UPDATE',
        oldValues: { fileId, ...withoutText(old, 'notes') },
        newValues: withoutText(next, 'notes'),
      });
      return toWitness(row);
    });
  }

  async remove(fileId: string, witnessId: string): Promise<void> {
    const { officeId } = this.caller();
    await this.access.assertFileAccess(fileId, 'write');
    await this.uow.run(async (tx) => {
      await lockFile(tx, officeId, fileId);
      const row = await this.witnessIn(tx, fileId, witnessId);
      await tx.witness.delete({ where: { id: witnessId } });
      await this.audit.log(tx, {
        entityType: 'Witness',
        entityId: witnessId,
        action: 'DELETE',
        oldValues: { fileId, fullName: row.fullName, statements: row._count.statements },
      });
    });
  }

  /** The witness's file, checked like every route on it (another office or an invisible file → 404). */
  private async fileOf(witnessId: string, mode: 'read' | 'write'): Promise<string> {
    const witness = await this.prisma.db.witness.findFirst({
      where: { id: witnessId },
      select: { fileId: true },
    });
    if (!witness) throw new ResourceNotFoundException();
    await this.access.assertFileAccess(witness.fileId, mode);
    return witness.fileId;
  }

  async statements(witnessId: string): Promise<WitnessStatement[]> {
    await this.fileOf(witnessId, 'read');
    const rows = await this.prisma.db.witnessStatement.findMany({
      where: { witnessId },
      orderBy: [{ statementDate: 'desc' }, { id: 'desc' }],
      take: LIMIT,
      select: STATEMENT_SELECT,
    });
    return rows.map(toStatement);
  }

  private async today(): Promise<string> {
    const { timezone } = await this.prisma.db.office.findFirstOrThrow({
      select: { timezone: true },
    });
    return wallClock(new Date(), timezone).date;
  }

  /** Not after today (office zone), a hearing of the same file, a recorder who is an active colleague seeing the file. */
  private async assertRefs(
    tx: ScopedTransaction,
    fileId: string,
    input: { statementDate?: string; sessionId?: string | null; recordedById?: string },
  ): Promise<void> {
    if (input.statementDate && input.statementDate > (await this.today())) {
      throw new ValidationException([{ field: 'statementDate', message: 'validation.futureDate' }]);
    }
    if (
      input.sessionId &&
      (await tx.session.count({ where: { id: input.sessionId, fileId } })) === 0
    ) {
      throw new ValidationException([{ field: 'sessionId', message: 'validation.unknownSession' }]);
    }
    if (
      input.recordedById &&
      input.recordedById !== this.caller().userId &&
      !(await CaseAccessService.colleagueMay(tx, input.recordedById, 'view:assigned:cases', fileId))
    ) {
      throw new ValidationException([
        { field: 'recordedById', message: 'validation.unknownRecorder' },
      ]);
    }
  }

  async addStatement(
    witnessId: string,
    input: CreateWitnessStatementRequest,
  ): Promise<WitnessStatement> {
    const { userId, officeId } = this.caller();
    const fileId = await this.fileOf(witnessId, 'write');
    return this.uow.run(async (tx) => {
      await lockFile(tx, officeId, fileId);
      const witness = await this.witnessIn(tx, fileId, witnessId);
      await this.assertRefs(tx, fileId, input);
      const row = await tx.witnessStatement.create({
        data: {
          officeId,
          fileId,
          witnessId,
          statementDate: toDbDate(input.statementDate),
          text: input.text,
          sessionId: input.sessionId ?? null,
          recordedById: input.recordedById ?? userId,
          isUnderOath: input.isUnderOath ?? false,
        },
        select: STATEMENT_SELECT,
      });
      // Not portal-visible (PORTAL_TIMELINE_EVENT_TYPES); the testimony itself stays out of the payload.
      await this.timeline.record(tx, {
        fileId,
        eventType: 'WITNESS_STATEMENT_ADDED',
        sourceType: 'WitnessStatement',
        sourceId: row.id,
        payload: { witnessId, name: witness.fullName, statementDate: input.statementDate },
      });
      await this.audit.log(tx, {
        entityType: 'WitnessStatement',
        entityId: row.id,
        action: 'CREATE',
        newValues: {
          fileId,
          witnessId,
          statementDate: input.statementDate,
          sessionId: row.session?.id ?? null,
          recordedById: row.recordedBy.id,
          isUnderOath: row.isUnderOath,
        },
      });
      return toStatement(row);
    });
  }

  private async statementIn(tx: ScopedTransaction, witnessId: string, statementId: string) {
    const row = await tx.witnessStatement.findFirst({
      where: { id: statementId, witnessId },
      select: STATEMENT_SELECT,
    });
    if (!row) throw new ResourceNotFoundException();
    return toStatement(row);
  }

  async updateStatement(
    witnessId: string,
    statementId: string,
    input: UpdateWitnessStatementRequest,
  ): Promise<WitnessStatement> {
    if (Object.values(input).every((value) => value === undefined)) {
      throw new ValidationException([{ field: 'text', message: 'validation.required' }]);
    }
    const { officeId } = this.caller();
    const fileId = await this.fileOf(witnessId, 'write');
    return this.uow.run(async (tx) => {
      await lockFile(tx, officeId, fileId);
      const current = await this.statementIn(tx, witnessId, statementId);
      const before = {
        statementDate: current.statementDate,
        text: current.text,
        sessionId: current.session?.id ?? null,
        recordedById: current.recordedBy.id,
        isUnderOath: current.isUnderOath,
      };
      const { old, next } = changes(before, input);
      if (Object.keys(next).length === 0) return current;
      const changed = next as UpdateWitnessStatementRequest;
      await this.assertRefs(tx, fileId, changed);
      const { statementDate, ...rest } = changed;
      const row = await tx.witnessStatement.update({
        where: { id: statementId },
        data: { ...rest, ...(statementDate ? { statementDate: toDbDate(statementDate) } : {}) },
        select: STATEMENT_SELECT,
      });
      await this.audit.log(tx, {
        entityType: 'WitnessStatement',
        entityId: statementId,
        action: 'UPDATE',
        oldValues: { fileId, witnessId, ...withoutText(old, 'text') },
        newValues: withoutText(next, 'text'),
      });
      return toStatement(row);
    });
  }

  async removeStatement(witnessId: string, statementId: string): Promise<void> {
    const { officeId } = this.caller();
    const fileId = await this.fileOf(witnessId, 'write');
    await this.uow.run(async (tx) => {
      await lockFile(tx, officeId, fileId);
      await this.statementIn(tx, witnessId, statementId);
      await tx.witnessStatement.delete({ where: { id: statementId } });
      await this.audit.log(tx, {
        entityType: 'WitnessStatement',
        entityId: statementId,
        action: 'DELETE',
        oldValues: { fileId, witnessId },
      });
    });
  }
}
