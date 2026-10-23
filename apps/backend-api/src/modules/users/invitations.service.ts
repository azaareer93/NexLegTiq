import { Injectable } from '@nestjs/common';
import type { Invitation, InviteUserRequest } from '@nexlegtiq/shared-contracts';
import type { Role } from '@nexlegtiq/shared-types';
import { ClsService } from 'nestjs-cls';

import { hashOpaqueToken, newOpaqueToken } from '../../common/auth/opaque-token';
import type { RequestContext } from '../../common/context/request-context';
import {
  AppException,
  ResourceConflictException,
  ResourceNotFoundException,
} from '../../common/errors/app.exception';
import { QueueProducer } from '../../common/queue/queue-producer';
import { QUEUE } from '../../common/queue/queues';
import { PrismaService } from '../../database/prisma.service';
import { UnitOfWork } from '../../database/unit-of-work';
import type { AfterCommit, ScopedTransaction } from '../../database/unit-of-work';
import type { ClientInfo } from '../auth/client-info';
import { truncateUserAgent } from '../auth/client-info';
import { INVITATION_DAYS, SEND_INVITATION_JOB } from '../auth/invitation-links';
import { DAY_MS } from '../auth/link-limits';
import { EntitlementsService } from '../subscriptions/entitlements.service';

/** shortcut: no paging — an office has a handful of pending invitations; page it if that ever passes 500. */
const MAX_INVITATIONS = 500;
/** Since the last send or link rotation (the row's `updatedAt`). */
const RESEND_COOLDOWN_MS = 60_000;

const INVITATION_SELECT = {
  id: true,
  email: true,
  role: true,
  fullName: true,
  expiresAt: true,
  createdAt: true,
  invitedBy: { select: { id: true, fullName: true } },
} as const;

type InvitationRow = {
  id: string;
  email: string;
  role: Role;
  fullName: string | null;
  expiresAt: Date;
  createdAt: Date;
  invitedBy: { id: string; fullName: string };
};

/**
 * Team invitations (MVP-49, W2, D-134), for the office manager: invite, list, revoke and resend. A pending, unexpired
 * invitation holds a seat (D-122), so invite and resend check the plan under the office's team lock (the one team
 * management takes, D-124) — two invitations at once cannot both take the last seat. The email and its link are made by
 * the worker after the commit (InvitationLinks).
 */
@Injectable()
export class InvitationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly uow: UnitOfWork,
    private readonly cls: ClsService<RequestContext>,
    private readonly entitlements: EntitlementsService,
    private readonly queues: QueueProducer,
  ) {}

  async invite(input: InviteUserRequest, client: ClientInfo): Promise<Invitation> {
    const officeId = this.officeId();
    const now = new Date();
    const { email } = input;
    const id = await this.uow.run(async (tx, afterCommit) => {
      await this.lockTeam(tx);
      // unscoped: emails are unique across offices (D-032), so a user of any office makes the address unavailable.
      const taken = await this.prisma.unscoped().user.findUnique({
        where: { email },
        select: { id: true },
      });
      if (taken) throw new ResourceConflictException('RES-002', 'A user with this email exists');
      // A lapsed invitation is closed, so the address can be invited again (one PENDING row per office + email).
      await tx.officeInvitation.updateMany({
        where: { email, status: 'PENDING', expiresAt: { lte: now } },
        data: { status: 'EXPIRED' },
      });
      const pending = await tx.officeInvitation.findFirst({
        where: { email, status: 'PENDING' },
        select: { id: true },
      });
      if (pending)
        throw new ResourceConflictException(
          'RES-002',
          'This email already has a pending invitation',
        );
      await this.entitlements.assertUserSlot();
      const row = await tx.officeInvitation.create({
        data: {
          officeId,
          email,
          role: input.role,
          fullName: input.fullName ?? null,
          message: input.message || null,
          // Never emailed: the worker replaces it with the link's hash before sending.
          tokenHash: hashOpaqueToken(newOpaqueToken()),
          expiresAt: new Date(now.getTime() + INVITATION_DAYS * DAY_MS),
          invitedById: this.actorId(),
        },
        select: { id: true },
      });
      await tx.auditLog.create({
        data: this.audit(client, row.id, 'CREATE', null, { email, role: input.role }),
      });
      this.send(afterCommit, row.id);
      return row.id;
    });
    return this.get(id);
  }

  /** Pending invitations, newest first; EXPIRED once their link lapsed (a resend renews it). */
  async list(): Promise<Invitation[]> {
    const rows = await this.prisma.db.officeInvitation.findMany({
      where: { status: 'PENDING' },
      select: INVITATION_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: MAX_INVITATIONS,
    });
    const now = new Date();
    return rows.map((row) => present(row, now));
  }

  /** Revokes a pending invitation: its link stops working and the seat is free. Anything else is 404. */
  async revoke(id: string, client: ClientInfo): Promise<void> {
    await this.uow.run(async (tx) => {
      const revoked = await tx.officeInvitation.updateMany({
        where: { id, status: 'PENDING' },
        data: { status: 'REVOKED' },
      });
      if (revoked.count === 0) throw new ResourceNotFoundException();
      await tx.auditLog.create({
        data: this.audit(client, id, 'UPDATE', { status: 'PENDING' }, { status: 'REVOKED' }),
      });
    });
  }

  /**
   * Sends the invitation again with a new link, valid 7 days from now; the previous link stops working. An expired
   * invitation takes a seat again, so the plan is checked.
   */
  async resend(id: string, client: ClientInfo): Promise<Invitation> {
    const now = new Date();
    await this.uow.run(async (tx, afterCommit) => {
      await this.lockTeam(tx);
      const invitation = await tx.officeInvitation.findFirst({
        where: { id, status: 'PENDING' },
        select: { expiresAt: true, updatedAt: true },
      });
      if (!invitation) throw new ResourceNotFoundException();
      // One email a minute per invitation: resend must not turn our domain into a mailer for the manager's note.
      if (now.getTime() - invitation.updatedAt.getTime() < RESEND_COOLDOWN_MS)
        throw new AppException('RATE-001', 'Wait a minute before sending this invitation again');
      if (invitation.expiresAt <= now) await this.entitlements.assertUserSlot();
      const expiresAt = new Date(now.getTime() + INVITATION_DAYS * DAY_MS);
      // The old link dies now, not only when the worker sends the new one (the enqueue may fail).
      await tx.officeInvitation.update({
        where: { id },
        data: { expiresAt, tokenHash: hashOpaqueToken(newOpaqueToken()) },
      });
      await tx.auditLog.create({
        data: this.audit(
          client,
          id,
          'UPDATE',
          { expiresAt: invitation.expiresAt.toISOString() },
          { expiresAt: expiresAt.toISOString(), resent: true },
        ),
      });
      this.send(afterCommit, id);
    });
    return this.get(id);
  }

  private send(afterCommit: AfterCommit, invitationId: string): void {
    afterCommit(
      () => this.queues.enqueue(QUEUE.EMAIL, SEND_INVITATION_JOB, { invitationId }),
      'enqueue email/send-invitation',
    );
  }

  private async get(id: string): Promise<Invitation> {
    const row = await this.prisma.db.officeInvitation.findFirst({
      where: { id },
      select: INVITATION_SELECT,
    });
    if (!row) throw new ResourceNotFoundException();
    return present(row, new Date());
  }

  /** The office's team lock (D-124): invitations and team changes queue, so seats are counted once. */
  private async lockTeam(tx: ScopedTransaction): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`team:${this.officeId()}`}, 0))`;
  }

  private audit(
    client: ClientInfo,
    entityId: string,
    action: 'CREATE' | 'UPDATE',
    oldValues: object | null,
    newValues: object,
  ) {
    return {
      officeId: this.officeId(),
      userId: this.actorId(),
      entityType: 'OfficeInvitation',
      entityId,
      action,
      ...(oldValues && { oldValues }),
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

function present(row: InvitationRow, now: Date): Invitation {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    fullName: row.fullName,
    status: row.expiresAt <= now ? 'EXPIRED' : 'PENDING',
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    invitedBy: row.invitedBy,
  };
}
