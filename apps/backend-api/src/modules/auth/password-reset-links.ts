import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';

import { linkWindowStart, MAX_LINKS_PER_WINDOW, mayIssueLink } from './link-limits';
import { hashOpaqueToken, newOpaqueToken } from '../../common/auth/opaque-token';
import type { RequestContext } from '../../common/context/request-context';
import { TenantContextMissingError } from '../../common/tenancy/tenant.errors';
import { AppConfig } from '../../config/app-config';
import { PrismaService } from '../../database/prisma.service';

/** Reset links last one hour (auth-rbac.md, Flows). */
export const RESET_LINK_MINUTES = 60;

/** What the email worker sends for a password-reset job. */
export interface PasswordResetEmail {
  readonly to: string;
  readonly locale: 'AR' | 'EN';
  readonly vars: { readonly name: string; readonly link: string; readonly minutes: number };
}

/**
 * Creates password-reset links in the worker (D-086, same pattern as D-085's verification links), in the user's office:
 * earlier unused reset links stop working, a new one-hour link is stored as SHA-256 only, and the raw token goes straight
 * into the email — it never sits in Redis. Nothing is sent to a deactivated user, nor beyond the per-user limits.
 */
@Injectable()
export class PasswordResetLinks {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cls: ClsService<RequestContext>,
    private readonly config: AppConfig,
  ) {}

  async issue(
    userId: string,
    now: Date,
    options: { retry?: boolean } = {},
  ): Promise<PasswordResetEmail | null> {
    const officeId = this.cls.isActive() ? this.cls.get('officeId') : undefined;
    if (!officeId) throw new TenantContextMissingError('password reset link');
    const token = newOpaqueToken();
    const user = await this.prisma.db.$transaction(async (tx) => {
      const found = await tx.user.findFirst({
        where: { id: userId },
        select: { email: true, fullName: true, uiLanguage: true, isActive: true },
      });
      if (!found?.isActive) return null;
      const recent = await tx.passwordResetToken.findMany({
        where: { userId, createdAt: { gt: linkWindowStart(now, RESET_LINK_MINUTES * 60_000) } },
        select: { createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: MAX_LINKS_PER_WINDOW,
      });
      if (
        !mayIssueLink(
          recent.map((link) => link.createdAt),
          now,
          options.retry ?? false,
        )
      )
        return null;
      await tx.passwordResetToken.updateMany({
        where: { userId, usedAt: null },
        data: { usedAt: now },
      });
      await tx.passwordResetToken.create({
        data: {
          officeId,
          userId,
          tokenHash: hashOpaqueToken(token),
          expiresAt: new Date(now.getTime() + RESET_LINK_MINUTES * 60_000),
        },
      });
      return found;
    });
    if (!user) return null;
    return {
      to: user.email,
      locale: user.uiLanguage === 'EN' ? 'EN' : 'AR',
      vars: {
        name: user.fullName,
        link: `${this.config.mail.officeAppUrl}/reset-password?token=${token}`,
        minutes: RESET_LINK_MINUTES,
      },
    };
  }
}
