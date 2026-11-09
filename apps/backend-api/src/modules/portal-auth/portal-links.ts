import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';

import { PORTAL_RESET_LINK_MINUTES } from './portal-auth.constants';
import { hashOpaqueToken, newOpaqueToken } from '../../common/auth/opaque-token';
import type { RequestContext } from '../../common/context/request-context';
import { TenantContextMissingError } from '../../common/tenancy/tenant.errors';
import { AppConfig } from '../../config/app-config';
import { PrismaService } from '../../database/prisma.service';
import { DAY_MS, linkWindowStart, MAX_LINKS_PER_WINDOW, mayIssueLink } from '../auth/link-limits';

/** What the email worker sends for a portal invitation job. */
export interface ClientInvitationEmail {
  readonly to: string;
  readonly locale: 'AR' | 'EN';
  readonly vars: {
    readonly officeName: string;
    readonly clientName: string;
    readonly inviterName: string;
    readonly link: string;
    readonly days: number;
  };
}

/** What the email worker sends for a portal password-reset job. */
export interface ClientResetEmail {
  readonly to: string;
  readonly locale: 'AR' | 'EN';
  readonly vars: { readonly name: string; readonly link: string; readonly minutes: number };
}

/**
 * Creates portal invitation links in the worker (D-157, the D-134 pattern), in the invitation's office: a new token
 * replaces the stored hash, so only the newest email's link works, and the raw token goes straight into the email — it
 * never sits in Redis. Nothing is sent for an invitation that was accepted, revoked or has expired.
 */
@Injectable()
export class PortalInvitationLinks {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cls: ClsService<RequestContext>,
    private readonly config: AppConfig,
  ) {}

  async issue(invitationId: string, now: Date): Promise<ClientInvitationEmail | null> {
    if (!(this.cls.isActive() && this.cls.get('officeId'))) {
      throw new TenantContextMissingError('portal invitation link');
    }
    const invitation = await this.prisma.db.clientInvitation.findFirst({
      where: { id: invitationId, status: 'PENDING', expiresAt: { gt: now } },
      select: {
        email: true,
        expiresAt: true,
        client: { select: { displayName: true } },
        office: { select: { name: true, defaultLanguage: true } },
        invitedBy: { select: { fullName: true } },
      },
    });
    if (!invitation) return null;
    const token = newOpaqueToken();
    // Conditional on PENDING: a revoke or accept between the read and here wins and nothing is sent.
    const rotated = await this.prisma.db.clientInvitation.updateMany({
      where: { id: invitationId, status: 'PENDING' },
      data: { tokenHash: hashOpaqueToken(token) },
    });
    if (rotated.count === 0) return null;
    return {
      to: invitation.email,
      locale: invitation.office.defaultLanguage === 'EN' ? 'EN' : 'AR',
      vars: {
        officeName: invitation.office.name,
        clientName: invitation.client.displayName,
        inviterName: invitation.invitedBy.fullName,
        link: `${this.config.mail.clientPortalUrl}/accept-invite?token=${token}`,
        days: Math.max(1, Math.ceil((invitation.expiresAt.getTime() - now.getTime()) / DAY_MS)),
      },
    };
  }
}

/**
 * Creates portal password-reset links in the worker (D-157, the D-086 pattern): earlier unused links stop working, a new
 * one-hour link is stored as SHA-256 only and the raw token goes straight into the email. The job runs in the context
 * of one of the account's offices (jobs need one) and its language is that office's. Nothing is sent to a deactivated
 * account, nor beyond the per-account limits.
 */
@Injectable()
export class PortalPasswordResetLinks {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
  ) {}

  async issue(
    clientUserId: string,
    now: Date,
    options: { retry?: boolean } = {},
  ): Promise<ClientResetEmail | null> {
    const token = newOpaqueToken();
    // unscoped: portal accounts belong to no office.
    const raw = this.prisma.unscoped();
    const user = await raw.$transaction(async (tx) => {
      const found = await tx.clientUser.findFirst({
        where: { id: clientUserId, isActive: true },
        select: { email: true, fullName: true },
      });
      if (!found) return null;
      const recent = await tx.clientPasswordResetToken.findMany({
        where: {
          clientUserId,
          createdAt: { gt: linkWindowStart(now, PORTAL_RESET_LINK_MINUTES * 60_000) },
        },
        select: { createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: MAX_LINKS_PER_WINDOW,
      });
      const issuable = mayIssueLink(
        recent.map((link) => link.createdAt),
        now,
        options.retry ?? false,
      );
      if (!issuable) return null;
      await tx.clientPasswordResetToken.updateMany({
        where: { clientUserId, usedAt: null },
        data: { usedAt: now },
      });
      await tx.clientPasswordResetToken.create({
        data: {
          clientUserId,
          tokenHash: hashOpaqueToken(token),
          expiresAt: new Date(now.getTime() + PORTAL_RESET_LINK_MINUTES * 60_000),
        },
      });
      return found;
    });
    if (!user) return null;
    const office = await this.prisma.db.office.findFirst({ select: { defaultLanguage: true } });
    return {
      to: user.email,
      locale: office?.defaultLanguage === 'EN' ? 'EN' : 'AR',
      vars: {
        name: user.fullName,
        link: `${this.config.mail.clientPortalUrl}/reset-password?token=${token}`,
        minutes: PORTAL_RESET_LINK_MINUTES,
      },
    };
  }
}
