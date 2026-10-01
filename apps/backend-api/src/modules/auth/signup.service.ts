import { Injectable } from '@nestjs/common';
import type { RegisterRequest, VerifyEmailRequest } from '@nexlegtiq/shared-contracts';
import type { AccountType } from '@nexlegtiq/shared-types';
import { PinoLogger } from 'nestjs-pino';

import { hashOpaqueToken, newOpaqueToken } from '../../common/auth/opaque-token';
import { AppException } from '../../common/errors/app.exception';
import { TenantRunner } from '../../common/tenancy/tenant-runner';
import { AppConfig } from '../../config/app-config';
import { PrismaService } from '../../database/prisma.service';
import { AuthService } from './auth.service';
import type { IssuedSession } from './auth.service';
import { tenantContextFor } from './client-info';
import type { ClientInfo } from './client-info';
import { isVerificationOverdue, verificationLinkExpiry } from './email-verification';
import { PasswordHasher } from './password-hasher';
import { SignupRepository } from './signup.repository';
import type { ExistingAccount } from './signup.repository';
import { VerificationMailer } from './verification-mailer';

/** D-005/D-006/D-083: Palestine gets the 6-month freemium plan; elsewhere a 30-day trial sized by account type. */
const GLOBAL_TRIAL_PLAN: Record<AccountType, string> = {
  SOLO: 'GLOBAL_SOLO',
  FIRM: 'GLOBAL_SMALL_FIRM',
  CORPORATE: 'GLOBAL_PROFESSIONAL',
};

export function signupPlanCode(body: Pick<RegisterRequest, 'jurisdiction' | 'accountType'>): string {
  return body.jurisdiction === 'PALESTINE' ? 'PS_FREE' : GLOBAL_TRIAL_PLAN[body.accountType];
}

const EMAIL_TAKEN = 'An account with this email already exists';
const INVALID_LINK = 'Verification link is invalid or has expired';

/**
 * Office signup and email verification (MVP-39, workflow W1; D-083). Signup creates the office and everything it needs
 * in one transaction (SignupRepository), then logs the new manager in through the scoped client, like /auth/login.
 */
@Injectable()
export class SignupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantRunner,
    private readonly auth: AuthService,
    private readonly passwords: PasswordHasher,
    private readonly signups: SignupRepository,
    private readonly mailer: VerificationMailer,
    private readonly config: AppConfig,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(SignupService.name);
  }

  async register(body: RegisterRequest, client: ClientInfo): Promise<IssuedSession> {
    const now = new Date();
    const existing = await this.signups.findAccount(body.email);
    if (existing && !this.isReclaimable(existing, now)) throw new AppException('RES-002', EMAIL_TAKEN);

    const verificationToken = newOpaqueToken();
    const uiLanguage = body.defaultLanguage === 'EN' ? 'EN' : 'AR';
    const user = await this.signups.createOfficeAccount({
      body,
      planCode: signupPlanCode(body),
      passwordHash: await this.passwords.hash(body.password),
      uiLanguage,
      verificationTokenHash: hashOpaqueToken(verificationToken),
      verificationExpiresAt: verificationLinkExpiry(now),
      now,
      client,
      ...(existing ? { release: { userId: existing.id, officeId: existing.officeId } } : {}),
    });

    // Auto-login in the new office. A failure here leaves a complete office: the client should offer /auth/login.
    const opened = await this.tenant.run(tenantContextFor(user.officeId, user.id, client), () =>
      this.prisma.db.$transaction((tx) => this.auth.openSession(tx, user, { rememberMe: false, now, client })),
    );
    try {
      this.mailer.send({ userId: user.id, officeId: user.officeId, email: user.email, language: uiLanguage, token: verificationToken });
    } catch (error) {
      // The office is committed: a delivery problem must not turn signup into an error (resend comes with delivery).
      this.logger.error({ err: error, userId: user.id }, 'Could not hand off the verification email');
    }
    return this.auth.issue(user, opened);
  }

  /** Confirms the address. Unknown, used and expired links all get the same 410 RES-004. */
  async verifyEmail(body: VerifyEmailRequest, client: ClientInfo): Promise<void> {
    const now = new Date();
    const link = await this.signups.findVerificationLink(hashOpaqueToken(body.token));
    if (!link || link.usedAt !== null || link.expiresAt <= now) throw new AppException('RES-004', INVALID_LINK);
    const used = await this.tenant.run(tenantContextFor(link.officeId, link.userId, client), () =>
      this.signups.confirmVerification(link, now, client),
    );
    if (!used) throw new AppException('RES-004', INVALID_LINK);
  }

  /**
   * D-083: an email held by a signup that never verified within 7 days can be signed up again — only while verification
   * is enforced (otherwise nobody could have verified), and only if that office has no other users.
   */
  private isReclaimable(existing: ExistingAccount, now: Date): boolean {
    return this.config.auth.emailVerificationEnforced && existing.officeUsers === 1 && isVerificationOverdue(existing, now);
  }
}
