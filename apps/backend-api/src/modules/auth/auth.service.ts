import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { AuthSession, LoginRequest } from '@nexlegtiq/shared-contracts';
import { isRole, permissionsFor } from '@nexlegtiq/shared-types';

import { hashOpaqueToken, newOpaqueToken } from '../../common/auth/opaque-token';
import { AppException } from '../../common/errors/app.exception';
import { TenantRunner } from '../../common/tenancy/tenant-runner';
import { AppConfig } from '../../config/app-config';
import { PrismaService } from '../../database/prisma.service';
import type { ScopedPrismaClient } from '../../database/prisma.service';
import type { AuditAction, Prisma } from '../../generated/prisma/client';
import { ACCESS_TOKEN_TTL_SECONDS, JWT_AUDIENCE, JWT_ISSUER } from './auth.constants';
import type { AccessTokenClaims } from './auth.constants';
import { tenantContextFor, truncateUserAgent } from './client-info';
import type { ClientInfo } from './client-info';
import { isVerificationOverdue, verifyBy } from './email-verification';
import { isLocked } from './lockout';
import { LoginAttemptRepository } from './login-attempt.repository';
import { PasswordHasher } from './password-hasher';
import { refreshExpiry, rotatedExpiry } from './refresh-token';
import { RefreshTokenRepository, USER_FOR_SESSION } from './refresh-token.repository';

/** A session issued to the controller: the JSON body plus the refresh token for the cookie. */
export interface IssuedSession {
  readonly session: AuthSession;
  readonly refreshToken: string;
  readonly refreshExpiresAt: Date;
}

export type SessionUser = Prisma.UserGetPayload<{ select: typeof USER_FOR_SESSION }>;
/** The scoped client or a transaction opened on it. */
export type SessionTx = Pick<ScopedPrismaClient, 'refreshToken' | 'auditLog' | 'user'>;

/** A session created inside a transaction; `issue` turns it into the response once the transaction has committed. */
export interface OpenedSession {
  readonly familyId: string;
  readonly refreshToken: string;
  readonly refreshExpiresAt: Date;
}

/**
 * Login, refresh-token rotation with reuse detection, and logout (MVP-40, D-050, D-053, D-055, D-082).
 * Before the office is known (credentials, lockout, refresh-token lookup) the raw client is used; every write after
 * that runs in the user's office through TenantRunner and the scoped client, one transaction per write + audit row.
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantRunner,
    private readonly jwt: JwtService,
    private readonly passwords: PasswordHasher,
    private readonly refreshTokens: RefreshTokenRepository,
    private readonly loginAttempts: LoginAttemptRepository,
    private readonly config: AppConfig,
  ) {}

  async login(request: LoginRequest, client: ClientInfo): Promise<IssuedSession> {
    const now = new Date();
    if (isLocked(await this.loginAttempts.recentFailures(request.email, client.ip, now), now)) {
      throw new AppException('AUTH-007', 'Too many failed attempts; try again later');
    }
    // unscoped: login runs before any office is known; users are looked up by their globally unique email (D-032).
    const user = await this.prisma.unscoped().user.findUnique({
      where: { email: request.email },
      select: { ...USER_FOR_SESSION, passwordHash: true },
    });
    const valid = await this.passwords.verify(user?.passwordHash, request.password);
    // An inactive user or office counts as a failure: it must not reset the lockout counter. An overdue verification
    // does not: the password was right, and lockout would hide the actionable AUTH-010 behind AUTH-007.
    const allowed = valid && user !== null && user.isActive && user.office.isActive;
    await this.loginAttempts.record(request.email, client.ip, allowed);

    if (!valid || user === null) throw new AppException('AUTH-001', 'Invalid email or password');
    this.assertActive(user, now);

    const opened = await this.tenant.run(tenantContextFor(user.officeId, user.id, client), () =>
      this.prisma.db.$transaction((tx) => this.openSession(tx, user, { rememberMe: request.rememberMe, now, client })),
    );
    return this.issue(user, opened);
  }

  /**
   * Starts a session in the caller's transaction: a new refresh-token family, `lastLoginAt` and the LOGIN audit row.
   * Shared by login and signup (auto-login).
   */
  async openSession(
    tx: SessionTx,
    user: SessionUser,
    { rememberMe, now, client }: { rememberMe: boolean; now: Date; client: ClientInfo },
  ): Promise<OpenedSession> {
    const refreshToken = newOpaqueToken();
    const refreshExpiresAt = refreshExpiry(now, rememberMe);
    // A new family (session) per login; every rotation stays in it.
    const familyId = randomUUID();
    await tx.user.update({ where: { id: user.id }, data: { lastLoginAt: now } });
    await this.refreshTokens.create(tx, this.newTokenRow(user, familyId, refreshToken, refreshExpiresAt, client));
    await this.audit(tx, user, 'LOGIN', client);
    return { familyId, refreshToken, refreshExpiresAt };
  }

  /** Rotates the refresh token. A revoked token being replayed revokes the whole family (theft signal). */
  async refresh(refreshToken: string | undefined, client: ClientInfo): Promise<IssuedSession> {
    const existing = refreshToken ? await this.refreshTokens.findByHash(hashOpaqueToken(refreshToken)) : null;
    if (!existing) throw new AppException('AUTH-005', 'Invalid refresh token');
    const { user } = existing;

    return this.tenant.run(tenantContextFor(user.officeId, user.id, client), async () => {
      if (existing.revokedAt !== null) return this.reuseDetected(existing.familyId, user, client);
      const now = new Date();
      if (existing.expiresAt <= now) throw new AppException('AUTH-004', 'Refresh token expired');
      try {
        this.assertActive(user, now);
      } catch (error) {
        await this.prisma.db.$transaction((tx) => this.refreshTokens.revokeFamily(tx, existing.familyId));
        throw error;
      }

      const expiresAt = rotatedExpiry(now, existing, await this.refreshTokens.familyStartedAt(existing.familyId));
      if (expiresAt <= now) throw new AppException('AUTH-004', 'Refresh token expired');
      const token = newOpaqueToken();
      const rotated = await this.prisma.db.$transaction(async (tx) => {
        // Conditional claim: of two concurrent refreshes with the same token, only one can win.
        if (!(await this.refreshTokens.claim(tx, existing.id))) return false;
        const next = await this.refreshTokens.create(tx, this.newTokenRow(user, existing.familyId, token, expiresAt, client));
        await this.refreshTokens.linkReplacement(tx, existing.id, next.id);
        return true;
      });
      if (!rotated) return this.reuseDetected(existing.familyId, user, client);
      return this.issue(user, { familyId: existing.familyId, refreshToken: token, refreshExpiresAt: expiresAt });
    });
  }

  /** Revokes the session family of the given refresh token. Idempotent: an unknown or missing token is a no-op. */
  async logout(refreshToken: string | undefined, client: ClientInfo): Promise<void> {
    const existing = refreshToken ? await this.refreshTokens.findByHash(hashOpaqueToken(refreshToken)) : null;
    // Already revoked (second logout, or a rotated-away token): nothing to do and nothing to audit.
    if (!existing || existing.revokedAt !== null) return;
    await this.tenant.run(tenantContextFor(existing.user.officeId, existing.user.id, client), () =>
      this.prisma.db.$transaction(async (tx) => {
        await this.refreshTokens.revokeFamily(tx, existing.familyId);
        await this.audit(tx, existing.user, 'LOGOUT', client);
      }),
    );
  }

  private async reuseDetected(familyId: string, user: SessionUser, client: ClientInfo): Promise<never> {
    await this.prisma.db.$transaction(async (tx) => {
      await this.refreshTokens.revokeFamily(tx, familyId);
      await this.audit(tx, user, 'SECURITY', client, { reason: 'REFRESH_TOKEN_REUSE', familyId });
    });
    throw new AppException('AUTH-005', 'Invalid refresh token');
  }

  private newTokenRow(user: SessionUser, familyId: string, token: string, expiresAt: Date, client: ClientInfo) {
    return {
      officeId: user.officeId,
      userId: user.id,
      familyId,
      tokenHash: hashOpaqueToken(token),
      expiresAt,
      ipAddress: client.ip,
      userAgent: truncateUserAgent(client.userAgent),
    };
  }

  /** The response for an opened or rotated session: a fresh access token plus the user as the UI needs it. */
  async issue(user: SessionUser, { familyId, refreshToken, refreshExpiresAt }: OpenedSession): Promise<IssuedSession> {
    const claims: AccessTokenClaims = { sub: user.id, officeId: user.officeId, role: user.role, sid: familyId };
    const accessToken = await this.jwt.signAsync(claims, {
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      algorithm: 'HS256',
    });
    return {
      refreshToken,
      refreshExpiresAt,
      session: {
        accessToken,
        expiresIn: ACCESS_TOKEN_TTL_SECONDS,
        user: {
          id: user.id,
          fullName: user.fullName,
          email: user.email,
          role: user.role,
          officeId: user.officeId,
          officeName: user.office.name,
          uiLanguage: user.uiLanguage,
          permissions: [...permissionsFor(user.role)],
          emailVerified: user.emailVerifiedAt !== null,
          verifyBy: verifyBy(user)?.toISOString() ?? null,
        },
      },
    };
  }

  /**
   * Inactive user → 403 AUTH-006; suspended office → AUTH-006 with its own message (MVP-40 AC); email still unverified
   * 7 days after signup → 403 AUTH-010 (D-083).
   */
  private assertActive(user: SessionUser, now: Date): void {
    if (!user.isActive) throw new AppException('AUTH-006', 'User account is inactive');
    if (!user.office.isActive) throw new AppException('AUTH-006', 'Office is suspended');
    if (!isRole(user.role)) throw new AppException('AUTH-006', 'User account is inactive');
    if (this.config.auth.emailVerificationEnforced && isVerificationOverdue(user, now)) {
      throw new AppException('AUTH-010', 'Email address not verified');
    }
  }

  private async audit(tx: SessionTx, user: SessionUser, action: AuditAction, client: ClientInfo, details?: Prisma.InputJsonObject) {
    await tx.auditLog.create({
      data: {
        officeId: user.officeId,
        userId: user.id,
        entityType: 'User',
        entityId: user.id,
        action,
        newValues: details,
        ipAddress: client.ip,
        userAgent: truncateUserAgent(client.userAgent),
        requestId: client.requestId,
      },
    });
  }

}

