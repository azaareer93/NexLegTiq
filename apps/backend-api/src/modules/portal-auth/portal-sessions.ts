import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { PORTAL_REFRESH_TTL_MS, PORTAL_SESSION_MAX_MS } from './portal-auth.constants';
import { hashOpaqueToken, newOpaqueToken } from '../../common/auth/opaque-token';
import { AppException } from '../../common/errors/app.exception';
import { PrismaService } from '../../database/prisma.service';
import type { Prisma } from '../../generated/prisma/client';

export interface IssuedPortalSession {
  readonly refreshToken: string;
  readonly familyId: string;
  /** When the cookie stops being sent. */
  readonly expiresAt: Date;
}
export interface RotatedPortalSession extends IssuedPortalSession {
  readonly clientUserId: string;
}

type Tx = Prisma.TransactionClient;
type Rotation =
  | { readonly session: RotatedPortalSession }
  | {
      readonly refused: 'AUTH-004' | 'AUTH-005';
      readonly familyId: string | null;
      readonly reused?: boolean;
    };

/**
 * Portal sessions (D-157, the D-145 pattern): an opaque refresh token (SHA-256 at rest) per rotation, all of one sign-in
 * sharing a family. A token lasts 7 days and no session outlives 30; a token used twice ends its whole family. Platform
 * code: the raw client with a reason (D-080).
 */
@Injectable()
export class PortalSessions {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(PortalSessions.name);
  }

  start(tx: Tx, clientUserId: string, now: Date): Promise<IssuedPortalSession> {
    const cap = new Date(now.getTime() + PORTAL_SESSION_MAX_MS);
    return this.issue(tx, clientUserId, randomUUID(), now, cap, now);
  }

  /** Refused when unknown (AUTH-005), already used (the family ends: AUTH-005) or past its lifetime (AUTH-004). */
  async rotate(token: string, now: Date): Promise<RotatedPortalSession> {
    // unscoped: portal sessions belong to no office.
    const raw = this.prisma.unscoped();
    const outcome = await raw.$transaction(async (tx): Promise<Rotation> => {
      const session = await tx.clientSession.findUnique({
        where: { tokenHash: hashOpaqueToken(token) },
      });
      if (!session) return { refused: 'AUTH-005', familyId: null };
      // Serialise with a password reset (it updates this row before revoking), so no token slips past the revoke.
      await tx.$queryRaw`SELECT id FROM client_users WHERE id = ${session.clientUserId}::uuid FOR UPDATE`;
      if (session.revokedAt) {
        return { refused: 'AUTH-005', familyId: session.familyId, reused: true };
      }
      const cap = new Date(session.startedAt.getTime() + PORTAL_SESSION_MAX_MS);
      if (session.expiresAt <= now || cap <= now) {
        return { refused: 'AUTH-004', familyId: session.familyId };
      }
      const claimed = await tx.clientSession.updateMany({
        where: { id: session.id, revokedAt: null },
        data: { revokedAt: now },
      });
      if (claimed.count !== 1) {
        return { refused: 'AUTH-005', familyId: session.familyId, reused: true };
      }
      const next = await this.issue(
        tx,
        session.clientUserId,
        session.familyId,
        session.startedAt,
        cap,
        now,
      );
      await tx.clientSession.update({
        where: { id: session.id },
        data: { replacedById: next.sessionId },
      });
      return { session: { ...next, clientUserId: session.clientUserId } };
    });
    if ('session' in outcome) return outcome.session;
    // Ended outside the transaction: a refusal must not roll the family's end back.
    if (outcome.familyId) await this.endFamily(raw, outcome.familyId, now);
    if (outcome.reused) {
      this.logger.warn({ familyId: outcome.familyId }, 'Portal refresh token reused');
    }
    throw new AppException(
      outcome.refused,
      outcome.refused === 'AUTH-004'
        ? 'Portal session ended'
        : 'Portal refresh token invalid or reused',
    );
  }

  /** Sign-out: the token's family ends. Returns the account only when something was ended (a second logout is a no-op). */
  async end(token: string, now: Date): Promise<string | null> {
    // unscoped: see rotate().
    const raw = this.prisma.unscoped();
    const session = await raw.clientSession.findUnique({
      where: { tokenHash: hashOpaqueToken(token) },
      select: { familyId: true, clientUserId: true },
    });
    if (!session) return null;
    return (await this.endFamily(raw, session.familyId, now)) > 0 ? session.clientUserId : null;
  }

  /** Every session of an account ends (access revoked, password reset). */
  async endAll(clientUserId: string, now: Date, tx?: Pick<Tx, 'clientSession'>): Promise<void> {
    // unscoped: see rotate().
    const target = tx ?? this.prisma.unscoped();
    await target.clientSession.updateMany({
      where: { clientUserId, revokedAt: null },
      data: { revokedAt: now },
    });
  }

  /** Is this family still live? (The access token's `sid`: a signed-out session's token stops at once.) */
  async live(familyId: string, now: Date): Promise<boolean> {
    // unscoped: see rotate().
    const current = await this.prisma.unscoped().clientSession.findFirst({
      where: { familyId, revokedAt: null, expiresAt: { gt: now } },
      select: { id: true },
    });
    return current !== null;
  }

  private async issue(
    tx: Tx,
    clientUserId: string,
    familyId: string,
    startedAt: Date,
    cap: Date,
    now: Date,
  ): Promise<IssuedPortalSession & { readonly sessionId: string }> {
    const refreshToken = newOpaqueToken();
    const expiresAt = new Date(Math.min(now.getTime() + PORTAL_REFRESH_TTL_MS, cap.getTime()));
    const row = await tx.clientSession.create({
      data: {
        clientUserId,
        familyId,
        tokenHash: hashOpaqueToken(refreshToken),
        startedAt,
        expiresAt,
      },
      select: { id: true },
    });
    return { refreshToken, familyId, expiresAt, sessionId: row.id };
  }

  private async endFamily(
    tx: Pick<Tx, 'clientSession'>,
    familyId: string,
    now: Date,
  ): Promise<number> {
    const ended = await tx.clientSession.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: now },
    });
    return ended.count;
  }
}
