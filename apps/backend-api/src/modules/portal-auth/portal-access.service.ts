import { Injectable } from '@nestjs/common';
import type {
  CreatePortalInvitationRequest,
  PortalInvitation,
  PortalUsers,
} from '@nexlegtiq/shared-contracts';
import { ClsService } from 'nestjs-cls';

import { PORTAL_INVITATION_DAYS, SEND_CLIENT_INVITATION_JOB } from './portal-auth.constants';
import { PortalSessions } from './portal-sessions';
import { AuditService } from '../../common/audit/audit.service';
import { hashOpaqueToken, newOpaqueToken } from '../../common/auth/opaque-token';
import type { RequestContext } from '../../common/context/request-context';
import {
  PermissionDeniedException,
  ResourceConflictException,
  ResourceNotFoundException,
  ValidationException,
} from '../../common/errors/app.exception';
import { QueueProducer } from '../../common/queue/queue-producer';
import { QUEUE } from '../../common/queue/queues';
import { PrismaService } from '../../database/prisma.service';
import { UnitOfWork } from '../../database/unit-of-work';
import type { ScopedTransaction } from '../../database/unit-of-work';
import type { ClientInfo } from '../auth/client-info';
import { DAY_MS } from '../auth/link-limits';

/** shortcut: no paging — one client has a handful of portal users; page it if that ever passes 200. */
const MAX_ROWS = 200;

/**
 * The office's side of the client portal (D-158): invite a client's person, see who has access, revoke it. The link and
 * its email are made by the worker after the commit (PortalInvitationLinks). Every change has an audit row.
 */
@Injectable()
export class PortalAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly uow: UnitOfWork,
    private readonly audit: AuditService,
    private readonly queues: QueueProducer,
    private readonly sessions: PortalSessions,
    private readonly cls: ClsService<RequestContext>,
  ) {}

  async invite(
    clientId: string,
    input: CreatePortalInvitationRequest,
    client: ClientInfo,
  ): Promise<PortalInvitation> {
    const now = new Date();
    const { email } = input;
    return this.uow.run(async (tx, afterCommit) => {
      await this.liveClient(tx, clientId);
      await this.assertMayExposeFiles(tx, clientId);
      if (input.contactPersonId) {
        const contact = await tx.contactPerson.findFirst({
          where: { id: input.contactPersonId, clientId },
          select: { id: true },
        });
        if (!contact) {
          throw new ValidationException([
            { field: 'contactPersonId', message: 'validation.unknownContact' },
          ]);
        }
      }
      // unscoped: portal accounts belong to no office; only the id is read, to look for a live grant of this office.
      const account = await this.prisma.unscoped().clientUser.findUnique({
        where: { email },
        select: { id: true },
      });
      if (account) {
        const grant = await tx.clientPortalAccess.findFirst({
          where: { clientUserId: account.id, revokedAt: null },
          select: { id: true },
        });
        if (grant) {
          throw new ResourceConflictException('RES-002', 'This address already has portal access');
        }
      }
      // A lapsed invitation is closed, so the address can be invited again (one PENDING row per office + email).
      await tx.clientInvitation.updateMany({
        where: { email, status: 'PENDING', expiresAt: { lte: now } },
        data: { status: 'EXPIRED' },
      });
      const pending = await tx.clientInvitation.findFirst({
        where: { email, status: 'PENDING' },
        select: { id: true },
      });
      if (pending) {
        throw new ResourceConflictException(
          'RES-002',
          'This address already has a pending invitation',
        );
      }
      const row = await tx.clientInvitation.create({
        data: {
          officeId: this.officeId(),
          clientId,
          contactPersonId: input.contactPersonId ?? null,
          email,
          // Never sent: the worker stores the hash of the token it emails.
          tokenHash: hashOpaqueToken(newOpaqueToken()),
          expiresAt: new Date(now.getTime() + PORTAL_INVITATION_DAYS * DAY_MS),
          invitedById: this.actor(),
        },
      });
      await this.audit.log(
        tx,
        {
          entityType: 'ClientInvitation',
          entityId: row.id,
          action: 'CREATE',
          newValues: { clientId, email, contactPersonId: input.contactPersonId ?? null },
        },
        client,
      );
      afterCommit(
        () =>
          this.queues.enqueue(QUEUE.EMAIL, SEND_CLIENT_INVITATION_JOB, { invitationId: row.id }),
        'enqueue email/send-client-invitation',
      );
      return present(row);
    });
  }

  /** Accounts with live access to the client, and its pending invitations (EXPIRED once the link lapsed). */
  async list(clientId: string): Promise<PortalUsers> {
    await this.liveClient(this.prisma.db, clientId);
    const [grants, invitations] = await Promise.all([
      this.prisma.db.clientPortalAccess.findMany({
        where: { clientId, revokedAt: null },
        orderBy: { createdAt: 'desc' },
        take: MAX_ROWS,
      }),
      this.prisma.db.clientInvitation.findMany({
        where: { clientId, status: 'PENDING' },
        orderBy: { createdAt: 'desc' },
        take: MAX_ROWS,
      }),
    ]);
    // unscoped: portal accounts belong to no office; names of this office's grants only.
    const accounts = await this.prisma.unscoped().clientUser.findMany({
      where: { id: { in: grants.map((grant) => grant.clientUserId) } },
      select: { id: true, email: true, fullName: true },
    });
    const byId = new Map(accounts.map((account) => [account.id, account]));
    return {
      users: grants.flatMap((grant) => {
        const account = byId.get(grant.clientUserId);
        return account
          ? [
              {
                id: grant.id,
                email: account.email,
                fullName: account.fullName,
                contactPersonId: grant.contactPersonId,
                grantedAt: grant.createdAt.toISOString(),
              },
            ]
          : [];
      }),
      invitations: invitations.map(present),
    };
  }

  /** Ends the access: the grant is revoked and the account's sessions end at once (it can sign in again where it still has access). */
  async revokeAccess(clientId: string, accessId: string, client: ClientInfo): Promise<void> {
    await this.uow.run(async (tx, afterCommit) => {
      const grant = await tx.clientPortalAccess.findFirst({
        where: { id: accessId, clientId, revokedAt: null },
        select: { clientUserId: true },
      });
      if (!grant) throw new ResourceNotFoundException();
      const now = new Date();
      const revoked = await tx.clientPortalAccess.updateMany({
        where: { id: accessId, revokedAt: null },
        data: { revokedAt: now },
      });
      if (revoked.count === 0) throw new ResourceNotFoundException();
      await this.audit.log(
        tx,
        {
          entityType: 'ClientPortalAccess',
          entityId: accessId,
          action: 'UPDATE',
          oldValues: { revokedAt: null },
          newValues: { revokedAt: now.toISOString(), clientId },
        },
        client,
      );
      afterCommit(() => this.sessions.endAll(grant.clientUserId, now), 'end portal sessions');
    });
  }

  /** Withdraws a pending invitation: its link stops working. Anything else is 404. */
  async revokeInvitation(
    clientId: string,
    invitationId: string,
    client: ClientInfo,
  ): Promise<void> {
    await this.uow.run(async (tx) => {
      const revoked = await tx.clientInvitation.updateMany({
        where: { id: invitationId, clientId, status: 'PENDING' },
        data: { status: 'REVOKED' },
      });
      if (revoked.count === 0) throw new ResourceNotFoundException();
      await this.audit.log(
        tx,
        {
          entityType: 'ClientInvitation',
          entityId: invitationId,
          action: 'UPDATE',
          oldValues: { status: 'PENDING' },
          newValues: { status: 'REVOKED' },
        },
        client,
      );
    });
  }

  /**
   * A portal user sees every file of the client, so a client linked to a live confidential file may be invited only by the
   * people who may expose that file: the office manager or its responsible lawyer (D-140, D-096).
   */
  private async assertMayExposeFiles(tx: ScopedTransaction, clientId: string): Promise<void> {
    if (this.cls.get('role') === 'OFFICE_MANAGER') return;
    const hidden = await tx.legalFile.findFirst({
      where: {
        deletedAt: null,
        isConfidential: true,
        clients: { some: { clientId } },
        NOT: { responsibleLawyerId: this.actor() },
      },
      select: { id: true },
    });
    if (hidden) throw new PermissionDeniedException();
  }

  /** A live, active client of this office, else 404 (another office's client is the same 404). */
  private async liveClient(db: Pick<ScopedTransaction, 'client'>, clientId: string): Promise<void> {
    const found = await db.client.findFirst({
      where: { id: clientId, deletedAt: null, isActive: true },
      select: { id: true },
    });
    if (!found) throw new ResourceNotFoundException();
  }

  private officeId(): string {
    const officeId = this.cls.get('officeId');
    if (!officeId) throw new Error('No office in the request context');
    return officeId;
  }

  private actor(): string {
    const userId = this.cls.get('userId');
    if (!userId) throw new Error('No user in the request context');
    return userId;
  }
}

function present(row: {
  id: string;
  email: string;
  contactPersonId: string | null;
  expiresAt: Date;
  createdAt: Date;
}): PortalInvitation {
  return {
    id: row.id,
    email: row.email,
    contactPersonId: row.contactPersonId,
    status: row.expiresAt <= new Date() ? 'EXPIRED' : 'PENDING',
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}
