import { Injectable } from '@nestjs/common';
import type {
  CloseCaseRequest,
  FileTeamMember,
  ReassignCaseRequest,
} from '@nexlegtiq/shared-contracts';
import { ClsService } from 'nestjs-cls';

import { lockFile } from './file-lock';
import { FileTeamService } from './file-team.service';
import { AuditService } from '../../common/audit/audit.service';
import type { AuditClient } from '../../common/audit/audit.service';
import type { RequestContext } from '../../common/context/request-context';
import {
  BusinessRuleException,
  PermissionDeniedException,
  ResourceConflictException,
} from '../../common/errors/app.exception';
import { PrismaService } from '../../database/prisma.service';
import { UnitOfWork } from '../../database/unit-of-work';
import type { AfterCommit, ScopedTransaction } from '../../database/unit-of-work';
import { CaseAccessService } from '../legal-files/case-access.service';
import { todayIn } from '../legal-files/cases.service';
import { ReminderScheduler } from '../sessions/reminder-scheduler';
import { toDbDate } from '../tasks/tasks.repository';
import { TimelineService } from '../timeline/timeline.service';

type Transition = 'close' | 'reopen' | 'archive';

/**
 * Closing, reopening and archiving a file (MVP-64, D-153, workflows.md#close-reopen-archive). Every transition locks the
 * file and re-reads its status inside the transaction, so two at once queue; an archived file refuses all (BIZ-007).
 */
@Injectable()
export class FileLifecycleService {
  constructor(
    private readonly cls: ClsService<RequestContext>,
    private readonly prisma: PrismaService,
    private readonly uow: UnitOfWork,
    private readonly access: CaseAccessService,
    private readonly reminders: ReminderScheduler,
    private readonly timeline: TimelineService,
    private readonly audit: AuditService,
    private readonly team: FileTeamService,
  ) {}

  private officeId(): string {
    const officeId = this.cls.get('officeId');
    if (!officeId) throw new Error('No office in the request context');
    return officeId;
  }

  /**
   * Who may make the transition. Closing and reopening: the route's `close:case` / `reopen:case`, a LAWYER only as the
   * file's responsible lawyer (D-052, D-081). Archiving: the office manager and senior lawyers (the ticket's rule).
   */
  private assertMay(transition: Transition, responsibleLawyerId: string): void {
    const role = this.cls.get('role');
    const userId = this.cls.get('userId');
    if (transition === 'archive') {
      if (role !== 'OFFICE_MANAGER' && role !== 'SENIOR_LAWYER')
        throw new PermissionDeniedException();
    } else if (role === 'LAWYER' && responsibleLawyerId !== userId) {
      throw new PermissionDeniedException();
    }
  }

  private async locked(tx: ScopedTransaction, fileId: string, transition: Transition) {
    const file = await lockFile(tx, this.officeId(), fileId);
    this.assertMay(transition, file.responsibleLawyerId);
    return file;
  }

  private async record(
    tx: ScopedTransaction,
    fileId: string,
    oldStatus: string,
    newValues: Record<string, unknown>,
    client: AuditClient,
  ): Promise<void> {
    await this.audit.log(
      tx,
      {
        entityType: 'LegalFile',
        entityId: fileId,
        action: 'UPDATE',
        oldValues: { status: oldStatus },
        newValues,
      },
      client,
    );
  }

  /** Open tasks block it (BIZ-003) unless forced with a reason; pending reminders end (domain-model invariant 3). */
  async close(fileId: string, input: CloseCaseRequest, client: AuditClient): Promise<void> {
    await this.access.assertFileAccess(fileId, 'read');
    const { timezone } = await this.prisma.db.office.findFirstOrThrow({
      select: { timezone: true },
    });
    await this.uow.run(async (tx, afterCommit: AfterCommit) => {
      const file = await this.locked(tx, fileId, 'close');
      if (file.status === 'CLOSED') {
        throw new BusinessRuleException('BIZ-002', 'The file is already closed');
      }
      const { openTasks, reason, forceReason } = await this.closing(tx, fileId, input);
      const closingDate = todayIn(timezone, new Date());
      await tx.legalFile.update({
        where: { id: fileId },
        data: { status: 'CLOSED', closingDate: toDbDate(closingDate) },
      });
      await this.reminders.cancelForFile(tx, afterCommit, fileId);
      await this.timeline.record(tx, {
        fileId,
        eventType: 'FILE_CLOSED',
        // FILE_CLOSED is shown on the client portal (D-150): staff reasons stay in the audit row only.
        payload: forceReason ? { openTasks } : {},
      });
      await this.record(
        tx,
        fileId,
        file.status,
        { status: 'CLOSED', closingDate, reason, forceReason, openTasks },
        client,
      );
    });
  }

  /** Open tasks block a close unless it is forced (BIZ-003, with their count); the reasons as recorded. */
  private async closing(tx: ScopedTransaction, fileId: string, input: CloseCaseRequest) {
    const openTasks = await tx.task.count({ where: { fileId, status: { not: 'DONE' } } });
    if (openTasks > 0 && !input.force) {
      throw new BusinessRuleException('BIZ-003', 'The file has open tasks', [
        {
          field: 'force',
          message: 'validation.openTasks',
          params: { openTasks: String(openTasks) },
        },
      ]);
    }
    return {
      openTasks,
      reason: input.reason?.trim() || null,
      forceReason: openTasks > 0 ? (input.forceReason?.trim() ?? null) : null,
    };
  }

  /**
   * `POST /cases/:id/reassign`: the new responsible lawyer takes the role whether or not they are on the team yet; the
   * previous one stays as MEMBER and is notified too. Rights and eligibility are the team route's (D-140).
   */
  async reassign(
    fileId: string,
    input: ReassignCaseRequest,
    client: AuditClient,
  ): Promise<FileTeamMember[]> {
    const userId = input.newResponsibleLawyerId;
    const onTeam = await this.prisma.db.fileTeamMember.count({ where: { fileId, userId } });
    const reassignment = { note: input.note };
    return onTeam
      ? this.team.changeRole(fileId, userId, 'RESPONSIBLE_LAWYER', client, reassignment)
      : this.team.add(fileId, { userId, role: 'RESPONSIBLE_LAWYER' }, client, reassignment);
  }

  /** A closed file opens again; the reminders of its upcoming hearings are scheduled again (D-117). */
  async reopen(fileId: string, client: AuditClient): Promise<void> {
    await this.access.assertFileAccess(fileId, 'read');
    await this.uow.run(async (tx, afterCommit: AfterCommit) => {
      const file = await this.locked(tx, fileId, 'reopen');
      if (file.status !== 'CLOSED') throw new ResourceConflictException('RES-003');
      await tx.legalFile.update({
        where: { id: fileId },
        data: { status: 'OPEN', closingDate: null },
      });
      await this.reminders.resetForFile(tx, afterCommit, fileId);
      await this.timeline.record(tx, { fileId, eventType: 'FILE_REOPENED' });
      await this.record(tx, fileId, file.status, { status: 'OPEN', closingDate: null }, client);
    });
  }

  /** A closed file becomes read-only for everyone, still listed and searchable (D-052). */
  async archive(fileId: string, client: AuditClient): Promise<void> {
    await this.access.assertFileAccess(fileId, 'read');
    await this.uow.run(async (tx, afterCommit: AfterCommit) => {
      const file = await this.locked(tx, fileId, 'archive');
      if (file.status !== 'CLOSED') throw new ResourceConflictException('RES-003');
      // A closed file can still get hearings (only archived ones refuse them, D-116): their reminders end here.
      await this.reminders.cancelForFile(tx, afterCommit, fileId);
      await tx.legalFile.update({ where: { id: fileId }, data: { status: 'ARCHIVED' } });
      await this.record(tx, fileId, file.status, { status: 'ARCHIVED' }, client);
    });
  }
}
