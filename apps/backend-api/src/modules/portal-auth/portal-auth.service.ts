import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { passwordIsNotEmail } from '@nexlegtiq/shared-contracts';
import type {
  ForgotPasswordRequest,
  PortalLoginRequest,
  PortalSession,
  PortalUser,
  ResetPasswordRequest,
} from '@nexlegtiq/shared-contracts';
import type { OfficeId } from '@nexlegtiq/shared-types';
import { PinoLogger } from 'nestjs-pino';

import { PortalAccounts } from './portal-accounts';
import {
  PORTAL_ACCESS_TTL_SECONDS,
  PORTAL_AUDIENCE,
  PORTAL_JWT,
  portalAttemptKey,
  SEND_CLIENT_PASSWORD_RESET_JOB,
} from './portal-auth.constants';
import type { PortalAccessClaims } from './portal-auth.constants';
import { PortalSessions, PortalTokenReused } from './portal-sessions';
import type { IssuedPortalSession } from './portal-sessions';
import { hashOpaqueToken } from '../../common/auth/opaque-token';
import {
  AppException,
  ResourceNotFoundException,
  ValidationException,
} from '../../common/errors/app.exception';
import { QueueProducer } from '../../common/queue/queue-producer';
import { QUEUE } from '../../common/queue/queues';
import { TenantRunner } from '../../common/tenancy/tenant-runner';
import { AppConfig } from '../../config/app-config';
import { PrismaService } from '../../database/prisma.service';
import type { ClientUser, Prisma } from '../../generated/prisma/client';
import { JWT_ISSUER } from '../auth/auth.constants';
import type { ClientInfo } from '../auth/client-info';
import { isLocked } from '../auth/lockout';
import { LoginAttemptRepository } from '../auth/login-attempt.repository';
import { PasswordHasher } from '../auth/password-hasher';

export interface PortalSignIn {
  readonly session: PortalSession;
  readonly issued: IssuedPortalSession;
}

const INVALID_LINK = 'Reset link is invalid or has expired';

/**
 * The client-portal realm (D-158): sign-in with the D-053 lockout (keyed `portal:<email>`), refresh with rotation and
 * reuse detection, logout, password reset by emailed link (D-086 pattern) and the signed-in profile. A sign-in needs at
 * least one live grant in an active office; without one the account is refused like an inactive one (AUTH-006).
 */
@Injectable()
export class PortalAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly hasher: PasswordHasher,
    private readonly attempts: LoginAttemptRepository,
    private readonly sessions: PortalSessions,
    private readonly accounts: PortalAccounts,
    private readonly tenant: TenantRunner,
    private readonly queues: QueueProducer,
    @Inject(PORTAL_JWT) private readonly jwt: JwtService,
    private readonly config: AppConfig,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(PortalAuthService.name);
  }

  async login(body: PortalLoginRequest, client: ClientInfo): Promise<PortalSignIn> {
    const key = portalAttemptKey(body.email);
    const now = new Date();
    if (isLocked(await this.attempts.recentFailures(key, client.ip, now), now)) {
      throw new AppException('AUTH-007', 'Too many failed attempts');
    }
    // unscoped: portal accounts belong to no office (D-158).
    const user = await this.prisma
      .unscoped()
      .clientUser.findUnique({ where: { email: body.email } });
    const valid = await this.hasher.verify(user?.passwordHash, body.password);
    if (!user || !valid) {
      await this.attempts.record(key, client.ip, false);
      throw new AppException('AUTH-001', 'Invalid email or password');
    }
    const offices = await this.accounts.offices(user.id);
    if (!user.isActive || offices.length === 0) {
      await this.attempts.record(key, client.ip, false);
      throw new AppException('AUTH-006', 'Portal access is not active');
    }
    // unscoped: see above.
    const issued = await this.prisma
      .unscoped()
      .$transaction((tx) => this.openSession(tx, user.id, client, now));
    return this.signedIn(user, offices, client, issued);
  }

  /** A session, the last sign-in time and the LOGIN audit rows, in the caller's transaction. */
  async openSession(
    tx: Prisma.TransactionClient,
    clientUserId: string,
    client: ClientInfo,
    now: Date,
  ): Promise<IssuedPortalSession> {
    const issued = await this.sessions.start(tx, clientUserId, now);
    await tx.clientUser.update({ where: { id: clientUserId }, data: { lastLoginAt: now } });
    await this.accounts.audit(tx, clientUserId, 'LOGIN', client);
    return issued;
  }

  /** After the commit: the success resets the lockout (best effort — the session exists) and the token is signed. */
  async signedIn(
    user: Pick<ClientUser, 'id' | 'fullName' | 'email'>,
    offices: PortalUser['offices'],
    client: ClientInfo,
    issued: IssuedPortalSession,
  ): Promise<PortalSignIn> {
    await this.attempts
      .record(portalAttemptKey(user.email), client.ip, true)
      .catch((error: unknown) => {
        this.logger.warn({ err: error }, 'Portal sign-in success not recorded');
      });
    return { issued, session: await this.sessionFor(user, offices, issued.familyId) };
  }

  async refresh(token: string | undefined, client: ClientInfo): Promise<PortalSignIn> {
    if (!token) throw new AppException('AUTH-005', 'No portal session');
    const now = new Date();
    const issued = await this.sessions.rotate(token, now).catch(async (error: unknown) => {
      if (error instanceof PortalTokenReused) await this.auditReuse(error, client);
      throw error;
    });
    const user = await this.findActive(issued.clientUserId);
    const offices = user ? await this.accounts.offices(user.id) : [];
    if (!user || offices.length === 0) {
      await this.sessions.end(issued.refreshToken, now);
      throw new AppException('AUTH-006', 'Portal access is not active');
    }
    return { issued, session: await this.sessionFor(user, offices, issued.familyId) };
  }

  /** A used refresh token came back (a stolen copy): one SECURITY row per office of the account. Never turns the 401 into a 500. */
  private async auditReuse(error: PortalTokenReused, client: ClientInfo): Promise<void> {
    try {
      // unscoped: the account's grants span offices.
      await this.accounts.audit(this.prisma.unscoped(), error.clientUserId, 'SECURITY', client, {
        event: 'REFRESH_TOKEN_REUSED',
        familyId: error.familyId,
      });
    } catch (failure) {
      this.logger.error({ err: failure }, 'Portal token reuse not audited');
    }
  }

  /** Idempotent: an unknown or already ended token ends nothing and writes nothing. */
  async logout(token: string | undefined, client: ClientInfo): Promise<void> {
    if (!token) return;
    const clientUserId = await this.sessions.end(token, new Date());
    if (!clientUserId) return;
    // unscoped: the account's grants span offices.
    await this.accounts.audit(this.prisma.unscoped(), clientUserId, 'LOGOUT', client);
  }

  async profile(clientUserId: string): Promise<PortalUser> {
    const user = await this.findActive(clientUserId);
    if (!user) throw new ResourceNotFoundException();
    return {
      id: user.id,
      fullName: user.fullName,
      email: user.email,
      offices: await this.accounts.offices(user.id),
    };
  }

  /**
   * Always succeeds, whether or not the email has an account. For an active account with access the worker is asked for
   * a reset email, in the context of one of its offices (jobs need one) and without waiting, so both answers take the
   * same time.
   */
  async forgotPassword(body: ForgotPasswordRequest, client: ClientInfo): Promise<void> {
    // One query for every email, so known and unknown addresses take the same path; the worker checks the account again.
    // unscoped: portal accounts belong to no office.
    const grant = await this.prisma.unscoped().clientPortalAccess.findFirst({
      where: {
        revokedAt: null,
        clientUser: { email: body.email, isActive: true },
        office: { isActive: true },
      },
      select: { officeId: true, clientUserId: true },
    });
    if (!grant) return;
    void this.tenant
      .run(
        {
          officeId: grant.officeId as OfficeId,
          ...(client.requestId ? { requestId: client.requestId } : {}),
        },
        () =>
          this.queues.enqueue(QUEUE.EMAIL, SEND_CLIENT_PASSWORD_RESET_JOB, {
            clientUserId: grant.clientUserId,
          }),
      )
      .catch((error: unknown) => {
        this.logger.error({ err: error }, 'Could not enqueue a portal reset email');
      });
  }

  /** Sets the new password with a valid link. Unknown, used or expired links, and those of a deactivated account, are 410 RES-004. */
  async resetPassword(body: ResetPasswordRequest, client: ClientInfo): Promise<void> {
    const now = new Date();
    // unscoped: portal accounts belong to no office.
    const raw = this.prisma.unscoped();
    const link = await raw.clientPasswordResetToken.findUnique({
      where: { tokenHash: hashOpaqueToken(body.token) },
      include: { clientUser: { select: { email: true, isActive: true } } },
    });
    if (!link || link.usedAt !== null || link.expiresAt <= now || !link.clientUser.isActive) {
      throw new AppException('RES-004', INVALID_LINK);
    }
    if (!passwordIsNotEmail(body.newPassword, link.clientUser.email)) {
      throw new ValidationException([
        { field: 'newPassword', message: 'validation.password.sameAsEmail' },
      ]);
    }
    const passwordHash = await this.hasher.hash(body.newPassword);
    const used = await raw.$transaction(async (tx) => {
      const claimed = await tx.clientPasswordResetToken.updateMany({
        where: { id: link.id, usedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now },
      });
      if (claimed.count !== 1) return false;
      // Updated before the sessions are revoked: a refresh racing this waits on the row lock (PortalSessions.rotate).
      await tx.clientUser.update({
        where: { id: link.clientUserId },
        data: { passwordHash, emailVerifiedAt: now },
      });
      await tx.clientPasswordResetToken.updateMany({
        where: { clientUserId: link.clientUserId, usedAt: null },
        data: { usedAt: now },
      });
      await this.sessions.endAll(link.clientUserId, now, tx);
      await this.accounts.audit(tx, link.clientUserId, 'UPDATE', client, { passwordReset: true });
      return true;
    });
    if (!used) throw new AppException('RES-004', INVALID_LINK);
  }

  private findActive(clientUserId: string): Promise<ClientUser | null> {
    // unscoped: see login().
    return this.prisma
      .unscoped()
      .clientUser.findFirst({ where: { id: clientUserId, isActive: true } });
  }

  private async sessionFor(
    user: Pick<ClientUser, 'id' | 'fullName' | 'email'>,
    offices: PortalUser['offices'],
    familyId: string,
  ): Promise<PortalSession> {
    const claims: PortalAccessClaims = { sub: user.id, sid: familyId };
    const accessToken = await this.jwt.signAsync(claims, {
      secret: this.secret(),
      audience: PORTAL_AUDIENCE,
      issuer: JWT_ISSUER,
      expiresIn: PORTAL_ACCESS_TTL_SECONDS,
    });
    return {
      accessToken,
      expiresIn: PORTAL_ACCESS_TTL_SECONDS,
      user: { id: user.id, fullName: user.fullName, email: user.email, offices },
    };
  }

  private secret(): string {
    const portal = this.config.portal;
    if (!portal) throw new ResourceNotFoundException();
    return portal.jwtSecret;
  }
}
