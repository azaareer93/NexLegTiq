import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { PlatformAuditService } from './platform-audit.service';
import { ADMIN_SESSION_IDLE_MS, ADMIN_SESSION_MAX_MS } from './platform-auth.constants';
import { hashOpaqueToken, newOpaqueToken } from '../../common/auth/opaque-token';
import { AppException } from '../../common/errors/app.exception';
import { PrismaService } from '../../database/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import type { ClientInfo } from '../auth/client-info';

export interface IssuedSession {
  readonly refreshToken: string;
  readonly familyId: string;
  /** When the cookie stops being sent: the session's 8 h end. */
  readonly expiresAt: Date;
}

export interface RotatedSession extends IssuedSession {
  readonly adminId: string;
}

type Tx = Prisma.TransactionClient;
type Rotation =
  | { readonly session: RotatedSession }
  | {
      readonly refused: 'AUTH-004' | 'AUTH-005';
      readonly familyId: string | null;
      /** Set when a used token came back: a stolen copy, recorded as a SECURITY event. */
      readonly reusedBy?: string;
    };

/**
 * Admin sessions (D-145): an opaque refresh token (SHA-256 at rest) per rotation, all of one sign-in sharing a family.
 * A session ends 8 h after sign-in, or 30 min after its last refresh; a token used twice ends its whole family (it was
 * copied). Platform code: the raw client with a reason (D-080).
 */
@Injectable()
export class PlatformSessions {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: PlatformAuditService,
  ) {}

  /** A new session at sign-in. */
  async start(tx: Tx, adminId: string, now: Date): Promise<IssuedSession> {
    const expiresAt = new Date(now.getTime() + ADMIN_SESSION_MAX_MS);
    return this.issue(tx, adminId, randomUUID(), now, expiresAt, now);
  }

  /**
   * The next token of a session: refused when the token is unknown (AUTH-005), already used (its family ends: AUTH-005),
   * past its 8 h (AUTH-004) or idle for 30 min (AUTH-004). The old token is claimed conditionally, so two concurrent
   * refreshes cannot both rotate it.
   */
  async rotate(token: string, now: Date, client: ClientInfo): Promise<RotatedSession> {
    // unscoped: admin sessions belong to no office.
    const raw = this.prisma.unscoped();
    const outcome = await raw.$transaction(async (tx): Promise<Rotation> => {
      const session = await tx.platformSession.findUnique({
        where: { tokenHash: hashOpaqueToken(token) },
      });
      if (!session) return { refused: 'AUTH-005', familyId: null };
      if (session.revokedAt) {
        return { refused: 'AUTH-005', familyId: session.familyId, reusedBy: session.adminId };
      }
      if (session.expiresAt <= now || session.idleUntil <= now) {
        return { refused: 'AUTH-004', familyId: session.familyId };
      }
      const claimed = await tx.platformSession.updateMany({
        where: { id: session.id, revokedAt: null },
        data: { revokedAt: now },
      });
      if (claimed.count !== 1) {
        return { refused: 'AUTH-005', familyId: session.familyId, reusedBy: session.adminId };
      }
      const next = await this.issue(
        tx,
        session.adminId,
        session.familyId,
        session.startedAt,
        session.expiresAt,
        now,
      );
      await tx.platformSession.update({
        where: { id: session.id },
        data: { replacedById: next.sessionId },
      });
      return { session: { ...next, adminId: session.adminId } };
    });
    if ('session' in outcome) return outcome.session;
    // Ended outside the transaction: a refusal must not roll the family's end back.
    if (outcome.familyId) await this.endFamily(raw, outcome.familyId, now);
    if (outcome.reusedBy) {
      await this.audit.log(
        {
          adminId: outcome.reusedBy,
          action: 'SECURITY',
          entityType: 'PlatformSession',
          entityId: outcome.familyId,
          newValues: { event: 'REFRESH_TOKEN_REUSED' },
        },
        client,
      );
    }
    throw new AppException(
      outcome.refused,
      outcome.refused === 'AUTH-004'
        ? 'Admin session ended'
        : 'Admin refresh token invalid or reused',
    );
  }

  /** Sign-out: the token's whole family ends. Unknown tokens end nothing. */
  async end(token: string, now: Date): Promise<string | null> {
    // unscoped: see rotate().
    const raw = this.prisma.unscoped();
    const session = await raw.platformSession.findUnique({
      where: { tokenHash: hashOpaqueToken(token) },
      select: { familyId: true, adminId: true, revokedAt: true },
    });
    if (!session) return null;
    // Only a sign-out that ended something is reported (and audited): a second one is a no-op.
    return (await this.endFamily(raw, session.familyId, now)) > 0 ? session.adminId : null;
  }

  /** Is this family still live? (The access token's `sid`: a signed-out session's token stops at once.) */
  async live(familyId: string, now: Date): Promise<boolean> {
    // unscoped: see rotate().
    const current = await this.prisma.unscoped().platformSession.findFirst({
      where: { familyId, revokedAt: null, expiresAt: { gt: now }, idleUntil: { gt: now } },
      select: { id: true },
    });
    return current !== null;
  }

  private async issue(
    tx: Tx,
    adminId: string,
    familyId: string,
    startedAt: Date,
    expiresAt: Date,
    now: Date,
  ): Promise<IssuedSession & { readonly sessionId: string }> {
    const refreshToken = newOpaqueToken();
    const idle = new Date(Math.min(now.getTime() + ADMIN_SESSION_IDLE_MS, expiresAt.getTime()));
    const row = await tx.platformSession.create({
      data: {
        adminId,
        familyId,
        tokenHash: hashOpaqueToken(refreshToken),
        startedAt,
        expiresAt,
        idleUntil: idle,
      },
      select: { id: true },
    });
    return { refreshToken, familyId, expiresAt, sessionId: row.id };
  }

  private async endFamily(
    tx: Pick<Tx, 'platformSession'>,
    familyId: string,
    now: Date,
  ): Promise<number> {
    const ended = await tx.platformSession.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: now },
    });
    return ended.count;
  }
}
