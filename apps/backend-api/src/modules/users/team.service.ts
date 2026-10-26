import { Injectable } from '@nestjs/common';
import type { DeactivateUserRequest, TeamMember, UserOpenFile } from '@nexlegtiq/shared-contracts';
import type { Role } from '@nexlegtiq/shared-types';
import { ClsService } from 'nestjs-cls';

import {
  assertAnotherManager,
  assertCoversAll,
  assertLawyers,
  assertRoleKeepsFiles,
  OPEN_FILE,
  present,
  releaseParalegalFiles,
} from './team.rules';
import { auditRow } from '../../common/audit/audit.service';
import type { RequestContext } from '../../common/context/request-context';
import {
  ResourceConflictException,
  ResourceNotFoundException,
} from '../../common/errors/app.exception';
import { RealtimePublisher } from '../../common/realtime/realtime.publisher';
import { PrismaService } from '../../database/prisma.service';
import { UnitOfWork } from '../../database/unit-of-work';
import type { AfterCommit, ScopedTransaction } from '../../database/unit-of-work';
import type { ClientInfo } from '../auth/client-info';
import { recipientsWanting } from '../notifications/notification-preferences';
import { ReminderScheduler } from '../sessions/reminder-scheduler';
import { EntitlementsService } from '../subscriptions/entitlements.service';

/** shortcut: no paging — offices have tens of users; page it if an office ever passes 500 (as the directory). */
const MAX_USERS = 500;
/** The contract's cap on `reassignments`; a lawyer with more open files is reassigned on the file pages first. */
const MAX_REASSIGNMENTS = 500;
/** Many files and hearings are rewritten in one transaction: more than Prisma's 5 s default. */
const DEACTIVATE_TIMEOUT_MS = 60_000;

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
    private readonly realtime: RealtimePublisher,
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
      take: MAX_REASSIGNMENTS,
    });
  }

  async changeRole(userId: string, role: Role, client: ClientInfo): Promise<TeamMember> {
    await this.uow.run(async (tx) => {
      await this.lockTeam(tx, userId);
      const user = await this.member(tx, userId);
      if (user.role === role) return;
      if (user.isActive && user.role === 'OFFICE_MANAGER') await assertAnotherManager(tx, userId);
      if (user.isActive) assertRoleKeepsFiles(user._count, role);
      await tx.user.update({ where: { id: userId }, data: { role } });
      const paralegalFilesCleared =
        user.role === 'PARALEGAL' ? await releaseParalegalFiles(tx, userId) : 0;
      await tx.auditLog.create({
        data: this.audit(
          client,
          'User',
          userId,
          { role: user.role },
          { role, ...(paralegalFilesCleared > 0 && { paralegalFilesCleared }) },
        ),
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
    await this.uow.run(
      async (tx, afterCommit) => {
        await this.lockTeam(tx, userId);
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
        afterCommit(async () => this.realtime.disconnectUser(userId), 'realtime disconnect');
        await tx.refreshToken.updateMany({
          where: { userId, revokedAt: null },
          data: { revokedAt: now },
        });
        const paralegalFilesCleared = await releaseParalegalFiles(tx, userId);
        // One preference read for every new lawyer, not one per file (D-146).
        const wanting = await recipientsWanting(
          tx,
          [...new Set(reassignments.map((row) => row.newResponsibleLawyerId))],
          'file.reassigned',
          'inApp',
        );
        for (const file of files) {
          const to = reassignments.find((row) => row.fileId === file.id)?.newResponsibleLawyerId;
          if (!to) continue;
          await this.reassign(
            tx,
            afterCommit,
            { ...file, from: userId, to, wants: wanting.has(to) },
            client,
          );
        }
        await tx.auditLog.create({
          data: this.audit(
            client,
            'User',
            userId,
            { isActive: true },
            {
              isActive: false,
              reassignedFiles: files.length,
              paralegalFilesCleared,
            },
          ),
        });
      },
      { timeoutMs: DEACTIVATE_TIMEOUT_MS },
    );
    return this.get(userId);
  }

  /** Reactivates a user when the plan has a free seat (422 BIZ-008). */
  async reactivate(userId: string, client: ClientInfo): Promise<TeamMember> {
    await this.uow.run(async (tx) => {
      await this.lockTeam(tx, userId);
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
    file: { id: string; fileNumber: string; from: string; to: string; wants: boolean },
    client: ClientInfo,
  ): Promise<void> {
    const officeId = this.officeId();
    // Conditional (D-096): a file deleted or closed since it was listed is a conflict, not a silent reassignment.
    const moved = await tx.legalFile.updateMany({
      where: { id: file.id, responsibleLawyerId: file.from, ...OPEN_FILE },
      data: { responsibleLawyerId: file.to },
    });
    if (moved.count === 0) throw new ResourceConflictException('RES-003');
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
    const notify = file.to !== this.actorId() && file.wants;
    if (notify) {
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
    // The new responsible lawyer is reminded of the file's upcoming hearings (D-117).
    await this.reminders.resetForFile(tx, afterCommit, file.id);
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

  /**
   * The office's team lock (two managers never pass the last-manager check together), then the user's row: a case being
   * opened for them holds it FOR SHARE (cases.service), so it commits first and is seen here, or waits and sees the change.
   */
  private async lockTeam(tx: ScopedTransaction, userId: string): Promise<void> {
    const officeId = this.officeId();
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`team:${officeId}`}, 0))`;
    await tx.$queryRaw`SELECT 1 FROM users WHERE id = ${userId}::uuid AND office_id = ${officeId}::uuid FOR UPDATE`;
  }

  private audit(
    client: ClientInfo,
    entityType: 'User' | 'LegalFile',
    entityId: string,
    oldValues: object,
    newValues: object,
  ) {
    return auditRow(
      {
        officeId: this.officeId(),
        userId: this.actorId(),
        entityType,
        entityId,
        action: 'UPDATE',
        oldValues,
        newValues,
      },
      client,
    );
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
