import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';

import { hashOpaqueToken, newOpaqueToken } from '../../common/auth/opaque-token';
import type { RequestContext } from '../../common/context/request-context';
import { TenantContextMissingError } from '../../common/tenancy/tenant.errors';
import { AppConfig } from '../../config/app-config';
import { PrismaService } from '../../database/prisma.service';
import { VERIFY_EMAIL_WITHIN_DAYS, verificationLinkExpiry } from './email-verification';

/** What the email worker sends for a verification job. */
export interface VerificationEmail {
  readonly to: string;
  readonly locale: 'AR' | 'EN';
  readonly vars: { readonly name: string; readonly link: string; readonly days: number };
}

/**
 * Creates signup verification links in the worker (D-085), in the user's office (TenantRunner context): earlier unused links
 * stop working, a new 7-day link is stored as SHA-256 only, and the raw token goes straight into the email. A retried job
 * simply issues another link. Nothing is sent once the user is verified or deactivated.
 * Resend abuse (D-085): at most one link a minute (a retry of the same job is exempt) and five a day per user, whatever
 * the number of IPs asking — so nobody can flood an inbox or keep killing the link the user just received.
 */
const DAY_MS = 86_400_000;
const COOLDOWN_MS = 60_000;
const MAX_LINKS_PER_DAY = 5;

@Injectable()
export class VerificationLinks {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cls: ClsService<RequestContext>,
    private readonly config: AppConfig,
  ) {}

  async issue(userId: string, now: Date, options: { retry?: boolean } = {}): Promise<VerificationEmail | null> {
    const officeId = this.cls.isActive() ? this.cls.get('officeId') : undefined;
    if (!officeId) throw new TenantContextMissingError('verification link');
    const token = newOpaqueToken();
    const user = await this.prisma.db.$transaction(async (tx) => {
      const found = await tx.user.findFirst({
        where: { id: userId },
        select: { email: true, fullName: true, uiLanguage: true, emailVerifiedAt: true, isActive: true },
      });
      if (!found || found.emailVerifiedAt !== null || !found.isActive) return null;
      const recent = await tx.emailVerificationToken.findMany({
        where: { userId, createdAt: { gt: new Date(now.getTime() - DAY_MS) } },
        select: { createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: MAX_LINKS_PER_DAY,
      });
      if (recent.length >= MAX_LINKS_PER_DAY) return null;
      const newest = recent[0]?.createdAt;
      if (!options.retry && newest && now.getTime() - newest.getTime() < COOLDOWN_MS) return null;
      await tx.emailVerificationToken.updateMany({ where: { userId, usedAt: null }, data: { usedAt: now } });
      await tx.emailVerificationToken.create({
        data: { officeId, userId, tokenHash: hashOpaqueToken(token), expiresAt: verificationLinkExpiry(now) },
      });
      return found;
    });
    if (!user) return null;
    return {
      to: user.email,
      locale: user.uiLanguage === 'EN' ? 'EN' : 'AR',
      vars: { name: user.fullName, link: `${this.config.mail.officeAppUrl}/verify-email?token=${token}`, days: VERIFY_EMAIL_WITHIN_DAYS },
    };
  }
}
