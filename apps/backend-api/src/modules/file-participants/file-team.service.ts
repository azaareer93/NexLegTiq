import { Injectable } from '@nestjs/common';
import type { AddTeamMemberRequest, FileTeamMember } from '@nexlegtiq/shared-contracts';
import type { FileTeamRole } from '@nexlegtiq/shared-types';
import { ClsService } from 'nestjs-cls';

import { lockFile } from './file-lock';
import type { LockedFile } from './file-lock';
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
import { RealtimePublisher } from '../../common/realtime/realtime.publisher';
import { PrismaService } from '../../database/prisma.service';
import { UnitOfWork } from '../../database/unit-of-work';
import type { AfterCommit, ScopedTransaction } from '../../database/unit-of-work';
import { CaseAccessService } from '../legal-files/case-access.service';
import { ReminderScheduler } from '../sessions/reminder-scheduler';

/** Office roles that may hold each file role (D-096): a responsible lawyer is a lawyer, a paralegal a PARALEGAL. */
const ELIGIBLE: Record<FileTeamRole, readonly string[] | null> = {
  RESPONSIBLE_LAWYER: ['OFFICE_MANAGER', 'SENIOR_LAWYER', 'LAWYER'],
  PARALEGAL: ['PARALEGAL'],
  MEMBER: null,
};
const ROLE_MESSAGE: Record<FileTeamRole, string> = {
  RESPONSIBLE_LAWYER: 'validation.responsibleLawyer',
  PARALEGAL: 'validation.responsibleParalegal',
  MEMBER: 'validation.teamMember',
};
const ROLE_ORDER: Record<FileTeamRole, number> = { RESPONSIBLE_LAWYER: 0, PARALEGAL: 1, MEMBER: 2 };

interface Change {
  readonly tx: ScopedTransaction;
  readonly afterCommit: AfterCommit;
  readonly fileId: string;
  readonly file: LockedFile;
  readonly client: AuditClient;
}

/**
 * The team of a file (D-033, D-140). Members are "assigned" (D-051): they see the file at once, and lose it when removed
 * — access is derived on every request. RESPONSIBLE_LAWYER and PARALEGAL are single roles kept in sync with the file's
 * `responsibleLawyerId` / `responsibleParalegalId`; giving them to someone moves the previous holder to MEMBER. A file
 * always has its responsible lawyer (422 BIZ-019 to remove or demote them without naming another).
 */
@Injectable()
export class FileTeamService {
  constructor(
    private readonly cls: ClsService<RequestContext>,
    private readonly prisma: PrismaService,
    private readonly uow: UnitOfWork,
    private readonly access: CaseAccessService,
    private readonly audit: AuditService,
    private readonly reminders: ReminderScheduler,
    private readonly realtime: RealtimePublisher,
  ) {}

  async list(fileId: string): Promise<FileTeamMember[]> {
    await this.access.assertFileAccess(fileId, 'read');
    return this.read(this.prisma.db, fileId);
  }

  /** An active colleague of the office (another office's or unknown user → 404); already on the team → 409 RES-002. */
  async add(
    fileId: string,
    input: AddTeamMemberRequest,
    client: AuditClient,
  ): Promise<FileTeamMember[]> {
    const role = input.role ?? 'MEMBER';
    await this.access.assertFileAccess(fileId, 'write');
    await this.uow.run(async (tx, afterCommit) => {
      const file = await lockFile(tx, this.officeId(), fileId);
      // Adding someone to a confidential file exposes it: the same people who set confidentiality decide (D-096).
      if (file.isConfidential && !this.mayExpose(file)) throw new PermissionDeniedException();
      await this.assertEligible(tx, input.userId, role);
      if (await tx.fileTeamMember.count({ where: { fileId, userId: input.userId } })) {
        throw new ResourceConflictException('RES-002');
      }
      const change = { tx, afterCommit, fileId, file, client };
      if (role !== 'MEMBER') await this.takeOver(change, input.userId, role);
      await tx.fileTeamMember.create({
        data: { officeId: this.officeId(), fileId, userId: input.userId, role },
      });
      await this.event(tx, fileId, 'TEAM_MEMBER_ADDED', { userId: input.userId, role });
      await this.audit.log(
        tx,
        {
          entityType: 'FileTeamMember',
          entityId: fileId,
          action: 'CREATE',
          newValues: { fileId, userId: input.userId, role },
        },
        client,
      );
      // A new responsible lawyer was already told the file is theirs (reassigned).
      if (role !== 'RESPONSIBLE_LAWYER') {
        await this.notifyAdded(tx, afterCommit, fileId, file, input.userId);
      }
    });
    return this.read(this.prisma.db, fileId);
  }

  /** A new role for a member; the responsible lawyer keeps the role until another is named (BIZ-019). */
  async changeRole(
    fileId: string,
    userId: string,
    role: FileTeamRole,
    client: AuditClient,
  ): Promise<FileTeamMember[]> {
    await this.access.assertFileAccess(fileId, 'write');
    await this.uow.run(async (tx, afterCommit) => {
      const file = await lockFile(tx, this.officeId(), fileId);
      const member = await this.member(tx, fileId, userId);
      if (member.role === role) return;
      if (member.role === 'RESPONSIBLE_LAWYER') throw this.needsLawyer();
      await this.assertEligible(tx, userId, role);
      const change = { tx, afterCommit, fileId, file, client };
      if (member.role === 'PARALEGAL') await this.clearParalegal(change);
      if (role !== 'MEMBER') await this.takeOver(change, userId, role);
      await tx.fileTeamMember.updateMany({ where: { fileId, userId }, data: { role } });
      await this.audit.log(
        tx,
        {
          entityType: 'FileTeamMember',
          entityId: fileId,
          action: 'UPDATE',
          oldValues: { userId, role: member.role },
          newValues: { userId, role },
        },
        client,
      );
    });
    return this.read(this.prisma.db, fileId);
  }

  /** Removing someone ends their "assigned" access at once; the responsible lawyer cannot leave (BIZ-019). */
  async remove(fileId: string, userId: string, client: AuditClient): Promise<void> {
    await this.access.assertFileAccess(fileId, 'write');
    await this.uow.run(async (tx, afterCommit) => {
      const file = await lockFile(tx, this.officeId(), fileId);
      const member = await this.member(tx, fileId, userId);
      if (member.role === 'RESPONSIBLE_LAWYER') throw this.needsLawyer();
      if (member.role === 'PARALEGAL') {
        await this.clearParalegal({ tx, afterCommit, fileId, file, client });
      }
      await tx.fileTeamMember.deleteMany({ where: { fileId, userId } });
      await this.event(tx, fileId, 'TEAM_MEMBER_REMOVED', { userId, role: member.role });
      await this.audit.log(
        tx,
        {
          entityType: 'FileTeamMember',
          entityId: fileId,
          action: 'DELETE',
          oldValues: { fileId, userId, role: member.role },
        },
        client,
      );
    });
  }

  /**
   * `userId` takes RESPONSIBLE_LAWYER or PARALEGAL: the previous holder stays on the team as MEMBER and the file's column
   * follows. A new responsible lawyer is a reassignment (D-118: `edit:any:case`), with its timeline event, notification
   * and reminders, as when a lawyer is deactivated (D-124).
   */
  private async takeOver(change: Change, userId: string, role: 'RESPONSIBLE_LAWYER' | 'PARALEGAL') {
    const { tx, fileId, file, client } = change;
    if (role === 'RESPONSIBLE_LAWYER' && !this.can('edit:any:case')) {
      throw new PermissionDeniedException();
    }
    await tx.fileTeamMember.updateMany({ where: { fileId, role }, data: { role: 'MEMBER' } });
    const column = role === 'RESPONSIBLE_LAWYER' ? 'responsibleLawyerId' : 'responsibleParalegalId';
    const previous =
      role === 'RESPONSIBLE_LAWYER' ? file.responsibleLawyerId : file.responsibleParalegalId;
    await tx.legalFile.update({ where: { id: fileId }, data: { [column]: userId } });
    await this.audit.log(
      tx,
      {
        entityType: 'LegalFile',
        entityId: fileId,
        action: 'UPDATE',
        oldValues: { [column]: previous },
        newValues: { [column]: userId },
      },
      client,
    );
    if (role === 'RESPONSIBLE_LAWYER') await this.reassigned(change, userId);
  }

  private async reassigned({ tx, afterCommit, fileId, file }: Change, userId: string) {
    await tx.caseTimelineEvent.create({
      data: {
        officeId: this.officeId(),
        fileId,
        eventType: 'FILE_REASSIGNED',
        actorId: this.actorId(),
        payload: { fromUserId: file.responsibleLawyerId, toUserId: userId, reason: 'TEAM' },
      },
    });
    await this.reminders.resetForFile(tx, afterCommit, fileId);
    await this.notify(tx, afterCommit, userId, {
      type: 'file.reassigned',
      titleKey: 'shell.notifications.fileReassigned',
      fileId,
      fileNumber: file.fileNumber,
    });
  }

  /** The paralegal leaves the role (removed or given another): the file has no responsible paralegal any more. */
  private async clearParalegal({ tx, fileId, file, client }: Change): Promise<void> {
    await tx.legalFile.update({ where: { id: fileId }, data: { responsibleParalegalId: null } });
    await this.audit.log(
      tx,
      {
        entityType: 'LegalFile',
        entityId: fileId,
        action: 'UPDATE',
        oldValues: { responsibleParalegalId: file.responsibleParalegalId },
        newValues: { responsibleParalegalId: null },
      },
      client,
    );
  }

  /**
   * The user is an active colleague whose office role may hold `role`, share-locked until commit so a deactivation or
   * role change (D-124) cannot slip in between. Unknown or another office's → 404 (D-019); otherwise 400 VAL-001.
   */
  private async assertEligible(tx: ScopedTransaction, userId: string, role: FileTeamRole) {
    const [user] = await tx.$queryRaw<{ role: string; isActive: boolean }[]>`
      SELECT role::text AS role, is_active AS "isActive" FROM users
      WHERE id = ${userId}::uuid AND office_id = ${this.officeId()}::uuid FOR SHARE`;
    if (!user) throw new ResourceNotFoundException();
    const allowed = ELIGIBLE[role];
    if (!user.isActive || (allowed && !allowed.includes(user.role))) {
      throw new ValidationException([{ field: 'userId', message: ROLE_MESSAGE[role] }]);
    }
  }

  private async member(tx: ScopedTransaction, fileId: string, userId: string) {
    const member = await tx.fileTeamMember.findFirst({
      where: { fileId, userId },
      select: { role: true },
    });
    if (!member) throw new ResourceNotFoundException();
    return member;
  }

  private needsLawyer(): BusinessRuleException {
    return new BusinessRuleException(
      'BIZ-019',
      'A file keeps its responsible lawyer until another one is named',
    );
  }

  /** Only the office manager and the file's responsible lawyer may expose a confidential file (D-096). */
  private mayExpose(file: LockedFile): boolean {
    return this.cls.get('role') === 'OFFICE_MANAGER' || file.responsibleLawyerId === this.actorId();
  }

  private can(permission: string): boolean {
    return (this.cls.get('permissions') ?? []).some((held) => held === permission);
  }

  private async notifyAdded(
    tx: ScopedTransaction,
    afterCommit: AfterCommit,
    fileId: string,
    file: LockedFile,
    userId: string,
  ): Promise<void> {
    await this.notify(tx, afterCommit, userId, {
      type: 'file.teamAdded',
      titleKey: 'shell.notifications.fileTeamAdded',
      fileId,
      fileNumber: file.fileNumber,
    });
  }

  /** In-app notification for a colleague (never for oneself), pushed to their open apps after the commit (D-129). */
  private async notify(
    tx: ScopedTransaction,
    afterCommit: AfterCommit,
    userId: string,
    note: { type: string; titleKey: string; fileId: string; fileNumber: string },
  ): Promise<void> {
    if (userId === this.actorId()) return;
    const notification = await tx.notification.create({
      data: {
        officeId: this.officeId(),
        userId,
        type: note.type,
        titleKey: note.titleKey,
        params: { fileId: note.fileId, fileNumber: note.fileNumber },
        link: `/cases/${note.fileId}`,
      },
      select: { id: true },
    });
    afterCommit(async () => {
      this.realtime.toUser(userId, 'notification', { notificationId: notification.id });
    }, 'realtime notification');
  }

  private async event(
    tx: ScopedTransaction,
    fileId: string,
    eventType: 'TEAM_MEMBER_ADDED' | 'TEAM_MEMBER_REMOVED',
    payload: Record<string, string>,
  ): Promise<void> {
    await tx.caseTimelineEvent.create({
      data: { officeId: this.officeId(), fileId, eventType, actorId: this.actorId(), payload },
    });
  }

  /** Responsible lawyer, paralegal, then members by name. */
  private async read(
    db: Pick<ScopedTransaction, 'fileTeamMember'>,
    fileId: string,
  ): Promise<FileTeamMember[]> {
    const rows = await db.fileTeamMember.findMany({
      where: { fileId },
      select: { role: true, user: { select: { id: true, fullName: true } } },
      orderBy: { user: { fullName: 'asc' } },
    });
    return rows
      .map(({ role, user }) => ({ ...user, role }))
      .sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role]);
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
