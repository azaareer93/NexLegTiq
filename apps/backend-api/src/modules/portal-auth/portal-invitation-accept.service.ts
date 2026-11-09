import { Injectable } from '@nestjs/common';
import { NewPasswordSchema, passwordIsNotEmail } from '@nexlegtiq/shared-contracts';
import type { PortalAcceptInviteRequest, PortalInvitePreview } from '@nexlegtiq/shared-contracts';
import type { OfficeId } from '@nexlegtiq/shared-types';

import { PortalAccounts } from './portal-accounts';
import { portalAttemptKey } from './portal-auth.constants';
import { PortalAuthService } from './portal-auth.service';
import type { PortalSignIn } from './portal-auth.service';
import { hashOpaqueToken } from '../../common/auth/opaque-token';
import {
  AppException,
  ResourceConflictException,
  ValidationException,
} from '../../common/errors/app.exception';
import { TenantRunner } from '../../common/tenancy/tenant-runner';
import { PrismaService } from '../../database/prisma.service';
import { truncateUserAgent } from '../auth/client-info';
import type { ClientInfo } from '../auth/client-info';
import { isLocked } from '../auth/lockout';
import { LoginAttemptRepository } from '../auth/login-attempt.repository';
import { PasswordHasher } from '../auth/password-hasher';
import { LEGAL_VERSIONS } from '../auth/signup.repository';
import { EntitlementsService } from '../subscriptions/entitlements.service';

const INVALID_LINK = 'Invitation link is invalid or has expired';

/**
 * The invitee's side of a portal invitation (D-158): preview it from its link, then accept it. A new address gets an
 * account with the chosen password; an address that already has one must give that account's password (the office is
 * added to it — one login per person). Unknown, used, revoked and expired links are all 410 RES-004; a suspended office
 * is 403 AUTH-006 and a read-only one 403 AUTH-104, as for office invitations (D-134).
 */
@Injectable()
export class PortalInvitationAcceptService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly hasher: PasswordHasher,
    private readonly attempts: LoginAttemptRepository,
    private readonly auth: PortalAuthService,
    private readonly accounts: PortalAccounts,
    private readonly tenant: TenantRunner,
    private readonly entitlements: EntitlementsService,
  ) {}

  async preview(token: string): Promise<PortalInvitePreview> {
    const invitation = await this.find(token, new Date());
    // unscoped: portal accounts belong to no office.
    const existing = await this.prisma.unscoped().clientUser.findUnique({
      where: { email: invitation.email },
      select: { id: true },
    });
    return {
      officeName: invitation.office.name,
      clientName: invitation.client.displayName,
      email: invitation.email,
      accountExists: existing !== null,
      expiresAt: invitation.expiresAt.toISOString(),
    };
  }

  async accept(body: PortalAcceptInviteRequest, client: ClientInfo): Promise<PortalSignIn> {
    const now = new Date();
    const invitation = await this.find(body.token, now);
    const { officeId, email } = invitation;
    // A public route, so SubscriptionGuard never sees it: a read-only office gains no portal users (D-122).
    const readOnly = await this.tenant.run(
      {
        officeId: officeId as OfficeId,
        ...(client.requestId ? { requestId: client.requestId } : {}),
      },
      async () => (await this.entitlements.current()).readOnly,
    );
    if (readOnly) throw new AppException('AUTH-104', 'Subscription ended: the office is read-only');
    await this.tenant.run(
      {
        officeId: officeId as OfficeId,
        ...(client.requestId ? { requestId: client.requestId } : {}),
      },
      () => this.entitlements.assertFeature('clientPortal'),
    );

    // unscoped: portal accounts belong to no office.
    const raw = this.prisma.unscoped();
    const existing = await raw.clientUser.findUnique({ where: { email } });
    const passwordHash = existing ? null : await this.newAccountHash(body, email);
    if (existing) await this.assertExistingPassword(existing, body.password, client, now);

    const issued = await raw
      .$transaction(async (tx) => {
        const claimed = await tx.clientInvitation.updateMany({
          where: { id: invitation.id, status: 'PENDING', expiresAt: { gt: now } },
          data: { status: 'ACCEPTED', acceptedAt: now },
        });
        if (claimed.count === 0) throw new AppException('RES-004', INVALID_LINK);
        const user =
          existing ??
          (await tx.clientUser.create({
            data: {
              email,
              fullName: body.fullName,
              passwordHash: passwordHash ?? '',
              emailVerifiedAt: now,
            },
          }));
        const access = await tx.clientPortalAccess.create({
          data: {
            officeId,
            clientUserId: user.id,
            clientId: invitation.clientId,
            contactPersonId: invitation.contactPersonId,
            grantedById: invitation.invitedById,
          },
          select: { id: true },
        });
        await tx.auditLog.create({
          data: {
            officeId,
            clientUserId: user.id,
            entityType: 'ClientPortalAccess',
            entityId: access.id,
            action: 'CREATE',
            newValues: {
              clientId: invitation.clientId,
              invitationId: invitation.id,
              newAccount: existing === null,
              termsVersion: LEGAL_VERSIONS.TOS,
              privacyVersion: LEGAL_VERSIONS.PRIVACY,
            },
            ipAddress: client.ip,
            userAgent: truncateUserAgent(client.userAgent),
            requestId: client.requestId,
          },
        });
        return { user, session: await this.auth.openSession(tx, user.id, client, now) };
      })
      .catch((error: unknown) => {
        // Two accepts for one new address, or a second live grant in the office: the unique indexes decide.
        if ((error as { code?: string }).code === 'P2002') {
          throw new ResourceConflictException('RES-002', 'This address already has portal access');
        }
        throw error;
      });
    const offices = await this.accounts.offices(issued.user.id);
    return this.auth.signedIn(issued.user, offices, client, issued.session);
  }

  private async newAccountHash(body: PortalAcceptInviteRequest, email: string): Promise<string> {
    // The policy applies to a new account's password only; an existing account's older password must still work.
    const policy = NewPasswordSchema.safeParse(body.password);
    if (!policy.success) {
      throw new ValidationException(
        policy.error.issues.map((issue) => ({ field: 'password', message: issue.message })),
      );
    }
    if (!passwordIsNotEmail(body.password, email)) {
      throw new ValidationException([
        { field: 'password', message: 'validation.password.sameAsEmail' },
      ]);
    }
    return this.hasher.hash(body.password);
  }

  /** An existing account proves itself with its password; failures count towards the sign-in lockout. */
  private async assertExistingPassword(
    user: { email: string; passwordHash: string; isActive: boolean },
    password: string,
    client: ClientInfo,
    now: Date,
  ): Promise<void> {
    const key = portalAttemptKey(user.email);
    if (isLocked(await this.attempts.recentFailures(key, client.ip, now), now)) {
      throw new AppException('AUTH-007', 'Too many failed attempts');
    }
    if (!(await this.hasher.verify(user.passwordHash, password))) {
      await this.attempts.record(key, client.ip, false);
      throw new AppException('AUTH-001', 'Invalid email or password');
    }
    if (!user.isActive) throw new AppException('AUTH-006', 'Portal access is not active');
  }

  private async find(token: string, now: Date) {
    // unscoped: the link is the only credential; the office is learned from the invitation itself.
    const invitation = await this.prisma.unscoped().clientInvitation.findUnique({
      where: { tokenHash: hashOpaqueToken(token) },
      select: {
        id: true,
        officeId: true,
        clientId: true,
        contactPersonId: true,
        invitedById: true,
        email: true,
        status: true,
        expiresAt: true,
        office: { select: { name: true, isActive: true } },
        client: { select: { displayName: true, isActive: true, deletedAt: true } },
      },
    });
    if (
      !invitation ||
      invitation.status !== 'PENDING' ||
      invitation.expiresAt <= now ||
      !invitation.client.isActive ||
      invitation.client.deletedAt !== null
    ) {
      throw new AppException('RES-004', INVALID_LINK);
    }
    if (!invitation.office.isActive) throw new AppException('AUTH-006', 'Office is suspended');
    return invitation;
  }
}
