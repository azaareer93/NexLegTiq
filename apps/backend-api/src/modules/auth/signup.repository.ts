import { Injectable } from '@nestjs/common';
import type { RegisterRequest } from '@nexlegtiq/shared-contracts';

import { AppException } from '../../common/errors/app.exception';
import { PrismaService } from '../../database/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import { truncateUserAgent } from './client-info';
import type { ClientInfo } from './client-info';
import { USER_FOR_SESSION } from './refresh-token.repository';

const DAY_MS = 86_400_000;

/** Current legal texts. Bump a version when its document changes; signups record the version they accepted (D-083). */
export const LEGAL_VERSIONS = { TOS: '2026-09-28', PRIVACY: '2026-09-28' } as const;

export interface NewOfficeAccount {
  readonly body: RegisterRequest;
  readonly planCode: string;
  readonly passwordHash: string;
  readonly uiLanguage: 'AR' | 'EN';
  readonly verificationTokenHash: string;
  readonly verificationExpiresAt: Date;
  readonly now: Date;
  readonly client: ClientInfo;
  /** An abandoned unverified signup holding this email, released in the same transaction (D-083). */
  readonly release?: { readonly userId: string; readonly officeId: string };
}

/** An existing account for a signup email, with what the reclaim rule needs. */
export interface ExistingAccount {
  readonly id: string;
  readonly officeId: string;
  readonly emailVerifiedAt: Date | null;
  readonly createdAt: Date;
  readonly officeUsers: number;
}

/**
 * Signup and verification-link rows (MVP-39, D-083). Signup runs before its office exists, so it uses the raw client
 * and sets `officeId` on every row (D-080); confirming a link runs in the link's office through the scoped client.
 */
@Injectable()
export class SignupRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findAccount(email: string): Promise<ExistingAccount | null> {
    // unscoped: signup runs before any office is known; emails are globally unique (D-032).
    const user = await this.prisma.unscoped().user.findUnique({
      where: { email },
      select: { id: true, officeId: true, emailVerifiedAt: true, createdAt: true, office: { select: { _count: { select: { users: true } } } } },
    });
    return user && { ...user, officeUsers: user.office._count.users };
  }

  /**
   * One transaction: the office, its settings, the OFFICE_MANAGER, the trial subscription, ToS/Privacy acceptances, the
   * verification link and the CREATE audit row. A concurrent signup with the same email loses on the unique index
   * (P2002 → 409 RES-002).
   */
  createOfficeAccount(input: NewOfficeAccount) {
    const { body, now, client } = input;
    // unscoped: signup creates the office itself (D-080: Office create needs the raw client).
    return this.prisma.unscoped().$transaction(async (tx) => {
      if (input.release) await this.releaseAbandoned(tx, input.release, body.email, input);
      // findFirst, not findUniqueOrThrow: a missing or deactivated plan is a deployment fault (500), not a 404.
      const plan = await tx.plan.findFirst({ where: { code: input.planCode, isActive: true } });
      if (!plan?.trialDays) throw new Error(`Signup plan ${input.planCode} is missing, inactive or has no trial length`);

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
      const user = await tx.user.create({
        data: {
          officeId,
          fullName: body.fullName,
          email: body.email,
          passwordHash: input.passwordHash,
          role: 'OFFICE_MANAGER',
          uiLanguage: input.uiLanguage,
          // Same clock as the link expiry: the 7-day deadline and the link end together.
          createdAt: now,
        },
        select: USER_FOR_SESSION,
      });
      const trialEndsAt = new Date(now.getTime() + plan.trialDays * DAY_MS);
      await tx.subscription.create({
        data: { officeId, planId: plan.id, status: 'TRIALING', currentPeriodStart: now, currentPeriodEnd: trialEndsAt, trialEndsAt },
      });
      await tx.legalAcceptance.createMany({
        data: (['TOS', 'PRIVACY'] as const).map((documentType) => ({
          officeId,
          userId: user.id,
          documentType,
          version: LEGAL_VERSIONS[documentType],
          acceptedAt: now,
          ipAddress: client.ip,
        })),
      });
      await tx.emailVerificationToken.create({
        data: { officeId, userId: user.id, tokenHash: input.verificationTokenHash, expiresAt: input.verificationExpiresAt },
      });
      await tx.auditLog.create({
        data: {
          ...auditBase(officeId, user.id, client),
          entityType: 'Office',
          entityId: officeId,
          action: 'CREATE',
          newValues: { name: office.name, accountType: office.accountType, jurisdiction: office.jurisdiction, plan: plan.code },
        },
      });
      return user;
    });
  }

  findVerificationLink(tokenHash: string) {
    // unscoped: the link is the only credential; the office is learned from the token row itself.
    return this.prisma.unscoped().emailVerificationToken.findUnique({
      where: { tokenHash },
      select: { id: true, officeId: true, userId: true, expiresAt: true, usedAt: true },
    });
  }

  /**
   * Uses the link and verifies its user, in the link's office (scoped client inside TenantRunner). False when the link
   * was used concurrently. Only a change is audited: a link for an already verified user is used but changes nothing.
   */
  confirmVerification(link: { id: string; officeId: string; userId: string }, now: Date, client: ClientInfo): Promise<boolean> {
    return this.prisma.db.$transaction(async (tx) => {
      const claimed = await tx.emailVerificationToken.updateMany({ where: { id: link.id, usedAt: null }, data: { usedAt: now } });
      if (claimed.count === 0) return false;
      const verified = await tx.user.updateMany({ where: { id: link.userId, emailVerifiedAt: null }, data: { emailVerifiedAt: now } });
      if (verified.count === 1) {
        await tx.auditLog.create({
          data: {
            ...auditBase(link.officeId, link.userId, client),
            entityType: 'User',
            entityId: link.userId,
            action: 'UPDATE',
            newValues: { emailVerified: true },
          },
        });
      }
      return true;
    });
  }

  /**
   * Frees the email of an abandoned signup: its only user never verified within 7 days. Nothing is deleted (audit rows
   * keep their FKs): the office is deactivated, its sessions and links end, and the user's email is renamed. The update
   * is conditional, so a verification racing with the reclaim wins and the new signup gets 409.
   */
  private async releaseAbandoned(tx: Prisma.TransactionClient, account: { userId: string; officeId: string }, email: string, input: NewOfficeAccount) {
    const released = await tx.user.updateMany({
      where: { id: account.userId, email, emailVerifiedAt: null },
      data: { email: `released+${account.userId}@invalid.nexlegtiq`, isActive: false },
    });
    if (released.count === 0) throw new AppException('RES-002', 'An account with this email already exists');
    await tx.office.update({ where: { id: account.officeId }, data: { isActive: false } });
    await tx.refreshToken.updateMany({ where: { officeId: account.officeId, revokedAt: null }, data: { revokedAt: input.now } });
    await tx.emailVerificationToken.updateMany({ where: { officeId: account.officeId, usedAt: null }, data: { usedAt: input.now } });
    await tx.auditLog.create({
      data: {
        ...auditBase(account.officeId, account.userId, input.client),
        entityType: 'Office',
        entityId: account.officeId,
        action: 'SECURITY',
        newValues: { reason: 'ABANDONED_SIGNUP_RELEASED' },
      },
    });
  }
}

function auditBase(officeId: string, userId: string, client: ClientInfo) {
  return { officeId, userId, ipAddress: client.ip, userAgent: truncateUserAgent(client.userAgent), requestId: client.requestId };
}
