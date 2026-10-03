import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../database/prisma.service';
import type { ScopedPrismaClient } from '../../database/prisma.service';

/** The scoped client or a transaction opened on it. */
type ScopedTx = Pick<ScopedPrismaClient, 'refreshToken'>;

export const USER_FOR_SESSION = {
  id: true,
  officeId: true,
  fullName: true,
  email: true,
  role: true,
  uiLanguage: true,
  isActive: true,
  emailVerifiedAt: true,
  createdAt: true,
  office: { select: { name: true, isActive: true } },
} as const;

export interface NewRefreshToken {
  readonly officeId: string;
  readonly userId: string;
  readonly familyId: string;
  readonly tokenHash: string;
  readonly expiresAt: Date;
  readonly ipAddress: string;
  readonly userAgent: string | null;
}

/**
 * Refresh-token rows (one family per login session; D-050, D-082). Lookup by hash happens before the office is known
 * (raw client); every write takes the scoped client or a transaction on it, inside TenantRunner.
 */
@Injectable()
export class RefreshTokenRepository {
  constructor(private readonly prisma: PrismaService) {}

  findByHash(tokenHash: string) {
    // unscoped: the cookie is the only credential; the office is learned from the token row itself.
    return this.prisma.unscoped().refreshToken.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        familyId: true,
        createdAt: true,
        expiresAt: true,
        revokedAt: true,
        user: { select: USER_FOR_SESSION },
      },
    });
  }

  /** When the session (family) started: the anchor of the absolute session cap. */
  async familyStartedAt(familyId: string): Promise<Date> {
    const first = await this.prisma.db.refreshToken.findFirst({
      where: { familyId },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    });
    return first?.createdAt ?? new Date();
  }

  create(tx: ScopedTx, token: NewRefreshToken) {
    return tx.refreshToken.create({ data: token });
  }

  /** Marks the token used; false if it was already revoked (lost a concurrent rotation or replayed). */
  async claim(tx: ScopedTx, id: string): Promise<boolean> {
    const claimed = await tx.refreshToken.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: new Date() } });
    return claimed.count === 1;
  }

  async linkReplacement(tx: ScopedTx, id: string, replacedById: string): Promise<void> {
    await tx.refreshToken.update({ where: { id }, data: { replacedById } });
  }

  async revokeFamily(tx: ScopedTx, familyId: string): Promise<void> {
    await tx.refreshToken.updateMany({ where: { familyId, revokedAt: null }, data: { revokedAt: new Date() } });
  }
}
