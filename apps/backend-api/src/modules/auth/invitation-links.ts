import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';

import { DAY_MS } from './link-limits';
import { hashOpaqueToken, newOpaqueToken } from '../../common/auth/opaque-token';
import type { RequestContext } from '../../common/context/request-context';
import { TenantContextMissingError } from '../../common/tenancy/tenant.errors';
import { AppConfig } from '../../config/app-config';
import { PrismaService } from '../../database/prisma.service';

/** Invitations last 7 days (W2); a resend renews them. */
export const INVITATION_DAYS = 7;
export const SEND_INVITATION_JOB = 'send-invitation';

/** What the email worker sends for an invitation job. */
export interface InvitationEmail {
  readonly to: string;
  readonly locale: 'AR' | 'EN';
  readonly vars: {
    readonly officeName: string;
    readonly inviterName: string;
    readonly link: string;
    readonly days: number;
    readonly message: string;
  };
}

/**
 * Creates invitation links in the worker (D-134, the D-085 pattern), in the invitation's office: a new token replaces the
 * stored hash, so only the newest email's link works, and the raw token goes straight into the email — it never sits in
 * Redis. Nothing is sent for an invitation that was accepted, revoked or has expired. The email is in the office's language
 * (the invitee has no account, so no language of their own yet).
 */
@Injectable()
export class InvitationLinks {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cls: ClsService<RequestContext>,
    private readonly config: AppConfig,
  ) {}

  async issue(invitationId: string, now: Date): Promise<InvitationEmail | null> {
    const officeId = this.cls.isActive() ? this.cls.get('officeId') : undefined;
    if (!officeId) throw new TenantContextMissingError('invitation link');
    const token = newOpaqueToken();
    const invitation = await this.prisma.db.officeInvitation.findFirst({
      where: { id: invitationId, status: 'PENDING', expiresAt: { gt: now } },
      select: {
        email: true,
        expiresAt: true,
        message: true,
        office: { select: { name: true, defaultLanguage: true } },
        invitedBy: { select: { fullName: true } },
      },
    });
    if (!invitation) return null;
    // Conditional on PENDING: a revoke or accept between the read and here wins and nothing is sent.
    const rotated = await this.prisma.db.officeInvitation.updateMany({
      where: { id: invitationId, status: 'PENDING' },
      data: { tokenHash: hashOpaqueToken(token) },
    });
    if (rotated.count === 0) return null;
    return {
      to: invitation.email,
      locale: invitation.office.defaultLanguage === 'EN' ? 'EN' : 'AR',
      vars: {
        officeName: invitation.office.name,
        inviterName: invitation.invitedBy.fullName,
        link: `${this.config.mail.officeAppUrl}/accept-invite?token=${token}`,
        days: Math.max(1, Math.ceil((invitation.expiresAt.getTime() - now.getTime()) / DAY_MS)),
        message: invitation.message ?? '',
      },
    };
  }
}
