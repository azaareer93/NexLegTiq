import { Injectable } from '@nestjs/common';
import { passwordIsNotEmail } from '@nexlegtiq/shared-contracts';
import type { AcceptInviteRequest, InvitePreview } from '@nexlegtiq/shared-contracts';

import { AuthService } from './auth.service';
import type { IssuedSession } from './auth.service';
import { tenantContextFor, truncateUserAgent } from './client-info';
import type { ClientInfo } from './client-info';
import { PasswordHasher } from './password-hasher';
import { USER_FOR_SESSION } from './refresh-token.repository';
import { LEGAL_VERSIONS } from './signup.repository';
import { hashOpaqueToken } from '../../common/auth/opaque-token';
import {
  AppException,
  ResourceConflictException,
  ValidationException,
} from '../../common/errors/app.exception';
import { uuidV7 } from '../../common/ids/uuid-v7';
import { RealtimePublisher } from '../../common/realtime/realtime.publisher';
import { TenantRunner } from '../../common/tenancy/tenant-runner';
import { PrismaService } from '../../database/prisma.service';
import { UnitOfWork } from '../../database/unit-of-work';
import { wants } from '../notifications/notification-preferences';
import { EntitlementsService } from '../subscriptions/entitlements.service';

const INVALID_LINK = 'Invitation link is invalid or has expired';

/**
 * The invitee's side of W2 (MVP-49, D-134): preview the invitation from its link, then accept it — the user is created
 * with the invitation's role in its office, the email counts as verified (the link proves it, D-083), the inviting manager
 * is notified in the app, and the new user is signed in like /auth/login. Unknown, used, revoked and expired links all
 * get the same 410 RES-004; a suspended office is 403 AUTH-006 (D-082).
 */
@Injectable()
export class InvitationAcceptService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantRunner,
    private readonly uow: UnitOfWork,
    private readonly auth: AuthService,
    private readonly passwords: PasswordHasher,
    private readonly realtime: RealtimePublisher,
    private readonly entitlements: EntitlementsService,
  ) {}

  async preview(token: string): Promise<InvitePreview> {
    const invitation = await this.find(token, new Date());
    return {
      officeName: invitation.office.name,
      inviterName: invitation.invitedBy.fullName,
      email: invitation.email,
      role: invitation.role,
      fullName: invitation.fullName,
      expiresAt: invitation.expiresAt.toISOString(),
    };
  }

  async accept(body: AcceptInviteRequest, client: ClientInfo): Promise<IssuedSession> {
    const now = new Date();
    const invitation = await this.find(body.token, now);
    if (!passwordIsNotEmail(body.password, invitation.email))
      throw new ValidationException([
        { field: 'password', message: 'validation.password.sameAsEmail' },
      ]);
    // unscoped: emails are unique across offices (D-032); someone may have signed up with it since the invitation.
    const taken = await this.prisma.unscoped().user.findUnique({
      where: { email: invitation.email },
      select: { id: true },
    });
    if (taken)
      throw new ResourceConflictException('RES-002', 'An account with this email already exists');
    const passwordHash = await this.passwords.hash(body.password);
    // The id is made here so the tenant context can name the new user as the actor of everything below.
    const userId = uuidV7(now.getTime());
    const { officeId } = invitation;
    return this.tenant.run(tenantContextFor(officeId, userId, client), async () => {
      // A public route, so SubscriptionGuard never sees it: an office whose subscription ended gains no users (D-122).
      if ((await this.entitlements.current()).readOnly)
        throw new AppException('AUTH-104', 'Subscription ended: the office is read-only');
      const { user, opened } = await this.uow.run(async (tx, afterCommit) => {
        // Conditional: a revoke, a second accept or the expiry between the read and here wins.
        const claimed = await tx.officeInvitation.updateMany({
          where: { id: invitation.id, status: 'PENDING', expiresAt: { gt: now } },
          data: { status: 'ACCEPTED', acceptedAt: now },
        });
        if (claimed.count === 0) throw new AppException('RES-004', INVALID_LINK);
        const user = await tx.user.create({
          data: {
            id: userId,
            officeId,
            fullName: body.fullName,
            email: invitation.email,
            passwordHash,
            role: invitation.role,
            phone: body.phone ?? null,
            uiLanguage: invitation.office.defaultLanguage === 'EN' ? 'EN' : 'AR',
            emailVerifiedAt: now,
          },
          select: USER_FOR_SESSION,
        });
        await tx.legalAcceptance.createMany({
          data: (['TOS', 'PRIVACY'] as const).map((documentType) => ({
            officeId,
            userId,
            documentType,
            version: LEGAL_VERSIONS[documentType],
            acceptedAt: now,
            ipAddress: client.ip,
          })),
        });
        await tx.auditLog.create({
          data: {
            officeId,
            userId,
            entityType: 'User',
            entityId: userId,
            action: 'CREATE',
            newValues: {
              email: invitation.email,
              role: invitation.role,
              invitationId: invitation.id,
            },
            ipAddress: client.ip,
            userAgent: truncateUserAgent(client.userAgent),
            requestId: client.requestId,
          },
        });
        // Every active office manager is told (W2), not only the inviter, who may have left since.
        const managers = await tx.user.findMany({
          where: { role: 'OFFICE_MANAGER', isActive: true },
          select: { id: true, notificationPrefs: true },
        });
        // Those who turned team notifications off in the app are skipped (D-146).
        for (const manager of managers.filter((m) =>
          wants(m.notificationPrefs, 'invitation.accepted', 'inApp'),
        )) {
          const notification = await tx.notification.create({
            data: {
              officeId,
              userId: manager.id,
              type: 'invitation.accepted',
              titleKey: 'shell.notifications.invitationAccepted',
              params: { userId, name: body.fullName },
              link: '/team',
            },
            select: { id: true },
          });
          afterCommit(async () => {
            this.realtime.toUser(manager.id, 'notification', { notificationId: notification.id });
          }, 'realtime notification');
        }
        const opened = await this.auth.openSession(tx, user, { rememberMe: false, now, client });
        return { user, opened };
      });
      return this.auth.issue(user, opened);
    });
  }

  private async find(token: string, now: Date) {
    // unscoped: the link is the only credential; the office is learned from the invitation itself.
    const invitation = await this.prisma.unscoped().officeInvitation.findUnique({
      where: { tokenHash: hashOpaqueToken(token) },
      select: {
        id: true,
        officeId: true,
        email: true,
        role: true,
        fullName: true,
        status: true,
        expiresAt: true,
        office: { select: { name: true, defaultLanguage: true, isActive: true } },
        invitedBy: { select: { fullName: true } },
      },
    });
    if (!invitation || invitation.status !== 'PENDING' || invitation.expiresAt <= now)
      throw new AppException('RES-004', INVALID_LINK);
    if (!invitation.office.isActive) throw new AppException('AUTH-006', 'Office is suspended');
    return invitation;
  }
}
