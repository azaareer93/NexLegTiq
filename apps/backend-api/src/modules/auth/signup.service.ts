import { Injectable } from '@nestjs/common';
import type { RegisterRequest, VerifyEmailRequest } from '@nexlegtiq/shared-contracts';
import type { AccountType, OfficeId, UserId } from '@nexlegtiq/shared-types';

import { hashOpaqueToken, newOpaqueToken } from '../../common/auth/opaque-token';
import { AppException } from '../../common/errors/app.exception';
import { TenantRunner } from '../../common/tenancy/tenant-runner';
import { PrismaService } from '../../database/prisma.service';
import { AuthService } from './auth.service';
import type { ClientInfo, IssuedSession } from './auth.service';
import { verificationLinkExpiry } from './email-verification';
import { PasswordHasher } from './password-hasher';
import { USER_FOR_SESSION } from './refresh-token.repository';
import { VerificationMailer } from './verification-mailer';

/** Current legal texts. Bump a version when its document changes; signups record the version they accepted (D-083). */
export const LEGAL_VERSIONS = { TOS: '2026-09-28', PRIVACY: '2026-09-28' } as const;

/** D-005/D-006/D-083: Palestine gets the 6-month freemium plan; elsewhere a 30-day trial sized by account type. */
const GLOBAL_TRIAL_PLAN: Record<AccountType, string> = {
  SOLO: 'GLOBAL_SOLO',
  FIRM: 'GLOBAL_SMALL_FIRM',
  CORPORATE: 'GLOBAL_PROFESSIONAL',
};

export function signupPlanCode(body: Pick<RegisterRequest, 'jurisdiction' | 'accountType'>): string {
  return body.jurisdiction === 'PALESTINE' ? 'PS_FREE' : GLOBAL_TRIAL_PLAN[body.accountType];
}

const DAY_MS = 86_400_000;
const INVALID_LINK = 'Verification link is invalid or has expired';

/**
 * Office signup and email verification (MVP-39, workflow W1; D-083). Signup creates the office and everything it needs
 * in one transaction on the raw client (the office does not exist yet, D-080), then logs the new manager in through the
 * scoped client, like /auth/login.
 */
@Injectable()
export class SignupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantRunner,
    private readonly auth: AuthService,
    private readonly passwords: PasswordHasher,
    private readonly mailer: VerificationMailer,
  ) {}

  async register(body: RegisterRequest, client: ClientInfo): Promise<IssuedSession> {
    // unscoped: signup runs before the office exists; emails are globally unique (D-032).
    const raw = this.prisma.unscoped();
    if (await raw.user.findUnique({ where: { email: body.email }, select: { id: true } })) {
      throw new AppException('RES-002', 'An account with this email already exists');
    }
    const now = new Date();
    const passwordHash = await this.passwords.hash(body.password);
    const verificationToken = newOpaqueToken();
    const uiLanguage = body.defaultLanguage === 'EN' ? 'EN' : 'AR';

    // A concurrent signup with the same email loses on the unique index: P2002 → 409 RES-002 (global filter).
    const user = await raw.$transaction(async (tx) => {
      const plan = await tx.plan.findUniqueOrThrow({ where: { code: signupPlanCode(body) } });
      if (plan.trialDays === null) throw new Error(`Plan ${plan.code} has no trial length`);
      const office = await tx.office.create({
        data: {
          name: body.officeName,
          accountType: body.accountType,
          jurisdiction: body.jurisdiction,
          defaultLanguage: body.defaultLanguage,
          currency: body.currency,
          phone: body.phone ?? null,
        },
      });
      const officeId = office.id;
      // Schema defaults: reminders 7/3/1 days, file numbers {YEAR}-{TYPE}-{SEQ:5}, 30-minute idle timeout.
      await tx.officeSettings.create({ data: { officeId } });
      const created = await tx.user.create({
        data: { officeId, fullName: body.fullName, email: body.email, passwordHash, role: 'OFFICE_MANAGER', uiLanguage },
        select: USER_FOR_SESSION,
      });
      const trialEndsAt = new Date(now.getTime() + plan.trialDays * DAY_MS);
      await tx.subscription.create({
        data: { officeId, planId: plan.id, status: 'TRIALING', currentPeriodStart: now, currentPeriodEnd: trialEndsAt, trialEndsAt },
      });
      await tx.legalAcceptance.createMany({
        data: (['TOS', 'PRIVACY'] as const).map((documentType) => ({
          officeId,
          userId: created.id,
          documentType,
          version: LEGAL_VERSIONS[documentType],
          acceptedAt: now,
          ipAddress: client.ip,
        })),
      });
      await tx.emailVerificationToken.create({
        data: { officeId, userId: created.id, tokenHash: hashOpaqueToken(verificationToken), expiresAt: verificationLinkExpiry(now) },
      });
      await tx.auditLog.create({
        data: {
          officeId,
          userId: created.id,
          entityType: 'Office',
          entityId: officeId,
          action: 'CREATE',
          newValues: { name: office.name, accountType: office.accountType, jurisdiction: office.jurisdiction, plan: plan.code },
          ipAddress: client.ip,
          userAgent: client.userAgent?.slice(0, 512) ?? null,
          requestId: client.requestId,
        },
      });
      return created;
    });

    // Auto-login in the new office, like /auth/login. A failure here leaves a complete office the user can log in to.
    const context = { officeId: user.officeId as OfficeId, userId: user.id as UserId, ...(client.requestId ? { requestId: client.requestId } : {}) };
    const opened = await this.tenant.run(context, () =>
      this.prisma.db.$transaction((tx) => this.auth.openSession(tx, user, false, now, client)),
    );
    this.mailer.send({ userId: user.id, officeId: user.officeId, email: user.email, language: uiLanguage, token: verificationToken });
    return this.auth.issue(user, opened);
  }

  /** Confirms the address. Unknown, used and expired links all get the same 410 RES-004. */
  async verifyEmail(body: VerifyEmailRequest, client: ClientInfo): Promise<void> {
    const now = new Date();
    // unscoped: the link is the only credential; the office is learned from the token row itself.
    const link = await this.prisma.unscoped().emailVerificationToken.findUnique({
      where: { tokenHash: hashOpaqueToken(body.token) },
      select: { id: true, officeId: true, userId: true, expiresAt: true, usedAt: true },
    });
    if (!link || link.usedAt !== null || link.expiresAt <= now) throw new AppException('RES-004', INVALID_LINK);

    const context = {
      officeId: link.officeId as OfficeId,
      userId: link.userId as UserId,
      ...(client.requestId ? { requestId: client.requestId } : {}),
    };
    await this.tenant.run(context, () =>
      this.prisma.db.$transaction(async (tx) => {
        // Single use, also against two concurrent clicks.
        const claimed = await tx.emailVerificationToken.updateMany({ where: { id: link.id, usedAt: null }, data: { usedAt: now } });
        if (claimed.count === 0) throw new AppException('RES-004', INVALID_LINK);
        await tx.user.updateMany({ where: { id: link.userId, emailVerifiedAt: null }, data: { emailVerifiedAt: now } });
        await tx.auditLog.create({
          data: {
            officeId: link.officeId,
            userId: link.userId,
            entityType: 'User',
            entityId: link.userId,
            action: 'UPDATE',
            newValues: { emailVerified: true },
            ipAddress: client.ip,
            userAgent: client.userAgent?.slice(0, 512) ?? null,
            requestId: client.requestId,
          },
        });
      }),
    );
  }
}
