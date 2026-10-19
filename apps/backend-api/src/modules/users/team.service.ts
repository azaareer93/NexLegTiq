import { Injectable } from '@nestjs/common';
import type { DeactivateUserRequest, TeamMember, UserOpenFile } from '@nexlegtiq/shared-contracts';
import { isRole } from '@nexlegtiq/shared-types';
import type { Role } from '@nexlegtiq/shared-types';
import { ClsService } from 'nestjs-cls';

import type { RequestContext } from '../../common/context/request-context';
import {
  BusinessRuleException,
  ResourceNotFoundException,
  ValidationException,
} from '../../common/errors/app.exception';
import { PrismaService } from '../../database/prisma.service';
import { UnitOfWork } from '../../database/unit-of-work';
import type { AfterCommit, ScopedTransaction } from '../../database/unit-of-work';
import type { ClientInfo } from '../auth/client-info';
import { truncateUserAgent } from '../auth/client-info';
import { ReminderScheduler } from '../sessions/reminder-scheduler';
import { EntitlementsService } from '../subscriptions/entitlements.service';

/** Who may be a file's responsible lawyer (D-096). */
const LAWYER_ROLES: readonly Role[] = ['OFFICE_MANAGER', 'SENIOR_LAWYER', 'LAWYER'];
/** Files that need a responsible lawyer: live and not closed (as BIZ-010 counts them, D-108). */
const OPEN_FILE = { deletedAt: null, status: { in: ['OPEN' as const, 'SUSPENDED' as const] } };
/** shortcut: no paging — offices have tens of users; page it if an office ever passes 500 (as the directory). */
const MAX_USERS = 500;

const MEMBER_SELECT = {
  id: true,
  fullName: true,
  email: true,
  role: true,
  isActive: true,
  lastLoginAt: true,
  _count: { select: { responsibleFiles: { where: OPEN_FILE } } },
} as const;

/**
 * Team management (MVP-50, W5, D-124): the office's users, role changes and deactivation with the reassignment of every
 * open file. Changes run under a per-office advisory lock, so two managers can never demote or deactivate each other
 * past the last OFFICE_MANAGER (BIZ-001).
 */
@Injectable()
export class TeamService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly uow: UnitOfWork,
    private readonly cls: ClsService<RequestContext>,
    private readonly entitlements: EntitlementsService,
    private readonly reminders: ReminderScheduler,
  ) {}

  async list(): Promise<TeamMember[]> {
    const users = await this.prisma.db.user.findMany({
      select: MEMBER_SELECT,
      orderBy: [{ isActive: 'desc' }, { fullName: 'asc' }, { id: 'asc' }],
      take: MAX_USERS,
    });
    return users.map(present).filter((user): user is TeamMember => user !== null);
  }

  /** The files `PATCH …/deactivate` must reassign, by number. */
  async openFiles(userId: string): Promise<UserOpenFile[]> {
    await this.member(this.prisma.db, userId);
    return this.prisma.db.legalFile.findMany({
      where: { responsibleLawyerId: userId, ...OPEN_FILE },
      select: { id: true, fileNumber: true, title: true },
      orderBy: { fileNumber: 'asc' },
    });
  }

  async changeRole(userId: string, role: Role, client: ClientInfo): Promise<TeamMember> {
    await this.uow.run(async (tx) => {
      await this.lockTeam(tx);
      const user = await this.member(tx, userId);
      if (user.role === role) return;
      if (user.isActive && user.role === 'OFFICE_MANAGER') await assertAnotherManager(tx, userId);
      // A responsible lawyer must hold a lawyer role (D-096): reassign their files (deactivate wizard) first.
      if (user.isActive && !LAWYER_ROLES.includes(role) && user._count.responsibleFiles > 0) {
        throw new ValidationException([{ field: 'role', message: 'validation.roleHasOpenFiles' }]);
      }
      await tx.user.update({ where: { id: userId }, data: { role } });
      await tx.auditLog.create({
        data: this.audit(client, 'User', userId, { role: user.role }, { role }),
      });
    });
    return this.get(userId);
  }

  /**
   * Deactivates a user (W5): every open file they are responsible for gets the new lawyer given for it (all or nothing),
   * their sessions end and the new lawyers are notified — one transaction. Deactivating an inactive user does nothing.
   */
  async deactivate(
    userId: string,
    input: DeactivateUserRequest,
    client: ClientInfo,
  ): Promise<TeamMember> {
    await this.uow.run(async (tx, afterCommit) => {
      await this.lockTeam(tx);
      const user = await this.member(tx, userId);
      if (!user.isActive) return;
      if (user.role === 'OFFICE_MANAGER') await assertAnotherManager(tx, userId);
      const files = await tx.legalFile.findMany({
        where: { responsibleLawyerId: userId, ...OPEN_FILE },
        select: { id: true, fileNumber: true },
      });
      const reassignments = input.reassignments ?? [];
      assertCoversAll(files, reassignments);
      await assertLawyers(tx, userId, reassignments);
      const now = new Date();
      await tx.user.update({ where: { id: userId }, data: { isActive: false } });
      await tx.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: now },
      });
      for (const file of files) {
        const to = reassignments.find((row) => row.fileId === file.id)?.newResponsibleLawyerId;
        if (to) await this.reassign(tx, afterCommit, { ...file, from: userId, to }, client);
      }
      await tx.auditLog.create({
        data: this.audit(
          client,
          'User',
          userId,
          { isActive: true },
          { isActive: false, reassignedFiles: files.length },
        ),
      });
    });
    return this.get(userId);
  }

  /** Reactivates a user when the plan has a free seat (422 BIZ-008). */
  async reactivate(userId: string, client: ClientInfo): Promise<TeamMember> {
    await this.uow.run(async (tx) => {
      await this.lockTeam(tx);
      const user = await this.member(tx, userId);
      if (user.isActive) return;
      await this.entitlements.assertUserSlot();
      await tx.user.update({ where: { id: userId }, data: { isActive: true } });
      await tx.auditLog.create({
        data: this.audit(client, 'User', userId, { isActive: false }, { isActive: true }),
      });
    });
    return this.get(userId);
  }

  private async reassign(
    tx: ScopedTransaction,
    afterCommit: AfterCommit,
    file: { id: string; fileNumber: string; from: string; to: string },
    client: ClientInfo,
  ): Promise<void> {
    const officeId = this.officeId();
    await tx.legalFile.update({ where: { id: file.id }, data: { responsibleLawyerId: file.to } });
    // One responsible lawyer per file (D-095): the leaver leaves the team, the new lawyer takes the role.
    await tx.fileTeamMember.deleteMany({ where: { fileId: file.id, userId: file.from } });
    await tx.fileTeamMember.upsert({
      where: { fileId_userId: { fileId: file.id, userId: file.to } },
      update: { role: 'RESPONSIBLE_LAWYER' },
      create: { officeId, fileId: file.id, userId: file.to, role: 'RESPONSIBLE_LAWYER' },
    });
    await tx.caseTimelineEvent.create({
      data: {
        officeId,
        fileId: file.id,
        eventType: 'FILE_REASSIGNED',
        actorId: this.actorId(),
        payload: { fromUserId: file.from, toUserId: file.to, reason: 'DEACTIVATION' },
      },
    });
    await tx.auditLog.create({
      data: this.audit(
        client,
        'LegalFile',
        file.id,
        { responsibleLawyerId: file.from },
        { responsibleLawyerId: file.to },
      ),
    });
    if (file.to !== this.actorId()) {
      await tx.notification.create({
        data: {
          officeId,
          userId: file.to,
          type: 'file.reassigned',
          titleKey: 'shell.notifications.fileReassigned',
          params: { fileId: file.id, fileNumber: file.fileNumber },
          link: `/cases/${file.id}`,
        },
      });
    }
    await this.resetReminders(tx, afterCommit, file.id);
  }

  /** The new responsible lawyer is reminded of the file's upcoming hearings (D-117 asks the reassign story for this). */
  private async resetReminders(
    tx: ScopedTransaction,
    afterCommit: AfterCommit,
    fileId: string,
  ): Promise<void> {
    const sessions = await tx.session.findMany({
      where: { fileId, isCancelled: false, outcome: null, startsAt: { gt: new Date() } },
      select: {
        id: true,
        fileId: true,
        startsAt: true,
        attendingLawyerId: true,
        reminderDays: true,
      },
    });
    for (const session of sessions) {
      await this.reminders.reset(tx, afterCommit, session, session.reminderDays, false);
    }
  }

  private async get(userId: string): Promise<TeamMember> {
    const member = present(await this.member(this.prisma.db, userId));
    if (!member) throw new ResourceNotFoundException();
    return member;
  }

  /** Another office's user, or a malformed id, is 404 (D-019). */
  private async member(db: Pick<ScopedTransaction, 'user'>, userId: string) {
    const user = await db.user.findFirst({ where: { id: userId }, select: MEMBER_SELECT });
    if (!user) throw new ResourceNotFoundException();
    return user;
  }

  private async lockTeam(tx: ScopedTransaction): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`team:${this.officeId()}`}, 0))`;
  }

  private audit(
    client: ClientInfo,
    entityType: 'User' | 'LegalFile',
    entityId: string,
    oldValues: object,
    newValues: object,
  ) {
    return {
      officeId: this.officeId(),
      userId: this.actorId(),
      entityType,
      entityId,
      action: 'UPDATE' as const,
      oldValues,
      newValues,
      ipAddress: client.ip,
      userAgent: truncateUserAgent(client.userAgent),
      requestId: client.requestId,
    };
  }

  private actorId(): string {
    const userId = this.cls.get('userId');
    if (!userId) throw new Error('No user in the request context');
    return userId;
  }

  private officeId(): string {
    const officeId = this.cls.get('officeId');
    if (!officeId) throw new Error('No office in the request context');
    return officeId;
  }
}

type MemberRow = {
  id: string;
  fullName: string;
  email: string;
  role: string;
  isActive: boolean;
  lastLoginAt: Date | null;
  _count: { responsibleFiles: number };
};

function present(user: MemberRow): TeamMember | null {
  if (!isRole(user.role)) return null;
  return {
    id: user.id,
    fullName: user.fullName,
    email: user.email,
    role: user.role,
    isActive: user.isActive,
    openFiles: user._count.responsibleFiles,
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
  };
}

/** 422 BIZ-001: the office must keep an active OFFICE_MANAGER. */
async function assertAnotherManager(tx: ScopedTransaction, userId: string): Promise<void> {
  const others = await tx.user.count({
    where: { role: 'OFFICE_MANAGER', isActive: true, id: { not: userId } },
  });
  if (others === 0) {
    throw new BusinessRuleException('BIZ-001', 'The office must keep an active office manager');
  }
}

type Reassignment = { fileId: string; newResponsibleLawyerId: string };

/** Exactly the user's open files: a missing one would be left without a lawyer, an extra one is not theirs. */
function assertCoversAll(files: readonly { id: string }[], rows: readonly Reassignment[]): void {
  const open = new Set(files.map((file) => file.id));
  const covered = rows.filter((row) => open.has(row.fileId)).length;
  if (covered !== open.size || rows.length !== open.size) {
    throw new ValidationException([
      { field: 'reassignments', message: 'validation.reassignAllFiles' },
    ]);
  }
}

/** Every new lawyer: an active OM/SL/L of the office, other than the user leaving. */
async function assertLawyers(
  tx: ScopedTransaction,
  leaving: string,
  rows: readonly Reassignment[],
): Promise<void> {
  const ids = [...new Set(rows.map((row) => row.newResponsibleLawyerId))];
  const valid = await tx.user.findMany({
    where: { id: { in: ids, not: leaving }, isActive: true, role: { in: [...LAWYER_ROLES] } },
    select: { id: true },
  });
  const ok = new Set(valid.map((user) => user.id));
  const details = rows.flatMap((row, index) =>
    ok.has(row.newResponsibleLawyerId)
      ? []
      : [
          {
            field: `reassignments.${index}.newResponsibleLawyerId`,
            message: 'validation.responsibleLawyer',
          },
        ],
  );
  if (details.length > 0) throw new ValidationException(details);
}
