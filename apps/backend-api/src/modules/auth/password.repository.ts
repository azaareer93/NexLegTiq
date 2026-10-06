import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../database/prisma.service';
import { truncateUserAgent } from './client-info';
import type { ClientInfo } from './client-info';
import { RefreshTokenRepository } from './refresh-token.repository';

/**
 * Password reset and change rows (D-086). Lookups by email or link hash happen before the office is known (raw client);
 * every write runs in the user's office through the scoped client, one transaction with its audit row.
 */
@Injectable()
export class PasswordRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly refreshTokens: RefreshTokenRepository,
  ) {}

  findAccount(email: string) {
    // unscoped: forgot-password runs before any office is known; emails are globally unique (D-032).
    return this.prisma.unscoped().user.findUnique({
      where: { email },
      select: { id: true, officeId: true, isActive: true, office: { select: { isActive: true } } },
    });
  }

  findResetLink(tokenHash: string) {
    // unscoped: the link is the only credential; the office is learned from the token row itself.
    return this.prisma.unscoped().passwordResetToken.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        officeId: true,
        userId: true,
        expiresAt: true,
        usedAt: true,
        user: { select: { email: true, isActive: true, office: { select: { isActive: true } } } },
      },
    });
  }

  /** The current user's hash and email, in the request's office (scoped client). */
  findCredentials(userId: string) {
    return this.prisma.db.user.findFirst({
      where: { id: userId },
      select: { passwordHash: true, email: true },
    });
  }

  /**
   * Uses the link and sets the new password: every session ends, every other reset link stops working, and the email
   * counts as verified (only its owner could open the link). False when the link was used concurrently.
   */
  resetPassword(
    link: { id: string; officeId: string; userId: string },
    passwordHash: string,
    now: Date,
    client: ClientInfo,
  ): Promise<boolean> {
    return this.prisma.db.$transaction(async (tx) => {
      const claimed = await tx.passwordResetToken.updateMany({
        where: { id: link.id, usedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now },
      });
      if (claimed.count === 0) return false;
      await tx.user.update({ where: { id: link.userId }, data: { passwordHash } });
      await tx.user.updateMany({
        where: { id: link.userId, emailVerifiedAt: null },
        data: { emailVerifiedAt: now },
      });
      await tx.passwordResetToken.updateMany({
        where: { userId: link.userId, usedAt: null },
        data: { usedAt: now },
      });
      await this.refreshTokens.revokeAllForUser(tx, link.userId, now);
      await tx.auditLog.create({
        data: audit(link.officeId, link.userId, { passwordReset: true }, client),
      });
      return true;
    });
  }

  /** Sets a new password chosen by the signed-in user: every other session ends, pending reset links stop working. */
  async changePassword(
    user: { userId: string; officeId: string; sessionId?: string },
    passwordHash: string,
    now: Date,
    client: ClientInfo,
  ) {
    await this.prisma.db.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.userId }, data: { passwordHash } });
      await tx.passwordResetToken.updateMany({
        where: { userId: user.userId, usedAt: null },
        data: { usedAt: now },
      });
      await this.refreshTokens.revokeAllForUser(tx, user.userId, now, user.sessionId);
      await tx.auditLog.create({
        data: audit(user.officeId, user.userId, { passwordChanged: true }, client),
      });
    });
  }
}

function audit(
  officeId: string,
  userId: string,
  newValues: Record<string, boolean>,
  client: ClientInfo,
) {
  return {
    officeId,
    userId,
    entityType: 'User',
    entityId: userId,
    action: 'UPDATE' as const,
    newValues,
    ipAddress: client.ip,
    userAgent: truncateUserAgent(client.userAgent),
    requestId: client.requestId,
  };
}
