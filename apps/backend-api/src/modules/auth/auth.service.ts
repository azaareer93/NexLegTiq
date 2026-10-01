import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { AuthSession, LoginRequest } from '@nexlegtiq/shared-contracts';
import { isRole, permissionsFor } from '@nexlegtiq/shared-types';
import type { OfficeId, UserId } from '@nexlegtiq/shared-types';

import { AppException } from '../../common/errors/app.exception';
import { TenantRunner } from '../../common/tenancy/tenant-runner';
import { PrismaService } from '../../database/prisma.service';
import type { AuditAction, Prisma } from '../../generated/prisma/client';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  hashRefreshToken,
  JWT_AUDIENCE,
  JWT_ISSUER,
  LOCKOUT_MAX_FAILURES,
  LOCKOUT_WINDOW_MS,
  newRefreshToken,
  refreshExpiry,
} from './auth.constants';
import type { AccessTokenClaims } from './auth.constants';
import { PasswordHasher } from './password-hasher';

/** Who is calling, for LoginAttempt rows and audit (D-076: requestId is correlation only). */
export interface ClientInfo {
  readonly ip: string;
  readonly userAgent: string | null;
  readonly requestId: string | null;
}

/** A session issued to the controller: the JSON body plus the refresh token for the cookie. */
export interface IssuedSession {
  readonly session: AuthSession;
  readonly refreshToken: string;
  readonly refreshExpiresAt: Date;
}

const USER_FOR_SESSION = {
  id: true,
  officeId: true,
  fullName: true,
  email: true,
  role: true,
  uiLanguage: true,
  isActive: true,
  office: { select: { name: true, isActive: true } },
} as const;
type SessionUser = Prisma.UserGetPayload<{ select: typeof USER_FOR_SESSION }>;

const MAX_USER_AGENT = 512;

/**
 * Login, refresh-token rotation with reuse detection, and logout (MVP-40, D-050, D-053, D-055, D-082).
 * Before the office is known (credentials, lockout, refresh-token lookup) the raw client is used; every write after
 * that runs in the user's office through TenantRunner and the scoped client.
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantRunner,
    private readonly jwt: JwtService,
    private readonly passwords: PasswordHasher,
  ) {}

  async login(request: LoginRequest, client: ClientInfo): Promise<IssuedSession> {
    if (await this.isLockedOut(request.email, client.ip)) {
      throw new AppException('AUTH-007', 'Too many failed attempts; try again later');
    }
    // unscoped: login runs before any office is known; users are looked up by their globally unique email (D-032).
    const user = await this.prisma.unscoped().user.findUnique({
      where: { email: request.email },
      select: { ...USER_FOR_SESSION, passwordHash: true },
    });
    const valid = await this.passwords.verify(user?.passwordHash, request.password);
    const allowed = valid && user !== null && user.isActive && user.office.isActive;
    await this.recordAttempt(request.email, client.ip, allowed);

    if (!valid || user === null) throw new AppException('AUTH-001', 'Invalid email or password');
    this.assertActive(user);

    return this.tenant.run(this.runContext(user, client), async () => {
      await this.prisma.db.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
      const issued = await this.startFamily(user, request.rememberMe, client);
      await this.audit(user, 'LOGIN', client);
      return issued;
    });
  }

  /** Rotates the refresh token. A revoked token being replayed revokes the whole family (theft signal). */
  async refresh(refreshToken: string | undefined, client: ClientInfo): Promise<IssuedSession> {
    const existing = await this.findRefreshToken(refreshToken);
    if (!existing) throw new AppException('AUTH-005', 'Invalid refresh token');
    const { user } = existing;

    return this.tenant.run(this.runContext(user, client), async () => {
      if (existing.revokedAt !== null) return this.reuseDetected(existing.familyId, user, client);
      if (existing.expiresAt <= new Date()) throw new AppException('AUTH-004', 'Refresh token expired');
      if (!user.isActive || !user.office.isActive) {
        await this.revokeFamily(existing.familyId);
        this.assertActive(user);
      }

      const token = newRefreshToken();
      const lifetime = existing.expiresAt.getTime() - existing.createdAt.getTime();
      const expiresAt = new Date(Date.now() + lifetime);
      const rotated = await this.prisma.db.$transaction(async (tx) => {
        // Conditional claim: of two concurrent refreshes with the same token, only one can win.
        const claimed = await tx.refreshToken.updateMany({
          where: { id: existing.id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        if (claimed.count === 0) return null;
        const next = await tx.refreshToken.create({
          data: {
            officeId: user.officeId,
            userId: user.id,
            familyId: existing.familyId,
            tokenHash: hashRefreshToken(token),
            expiresAt,
            ipAddress: client.ip,
            userAgent: truncate(client.userAgent),
          },
        });
        await tx.refreshToken.update({ where: { id: existing.id }, data: { replacedById: next.id } });
        return next;
      });
      if (!rotated) return this.reuseDetected(existing.familyId, user, client);
      return this.issue(user, existing.familyId, token, expiresAt);
    });
  }

  /** Revokes the session family of the given refresh token. Idempotent: an unknown or missing token is a no-op. */
  async logout(refreshToken: string | undefined, client: ClientInfo): Promise<void> {
    const existing = await this.findRefreshToken(refreshToken);
    if (!existing) return;
    await this.tenant.run(this.runContext(existing.user, client), async () => {
      await this.revokeFamily(existing.familyId);
      await this.audit(existing.user, 'LOGOUT', client);
    });
  }

  private async findRefreshToken(token: string | undefined) {
    if (!token) return null;
    // unscoped: the cookie is the only credential here; the office is learned from the token row itself.
    return this.prisma.unscoped().refreshToken.findUnique({
      where: { tokenHash: hashRefreshToken(token) },
      select: { id: true, familyId: true, expiresAt: true, revokedAt: true, createdAt: true, user: { select: USER_FOR_SESSION } },
    });
  }

  private async reuseDetected(familyId: string, user: SessionUser, client: ClientInfo): Promise<never> {
    await this.revokeFamily(familyId);
    await this.audit(user, 'SECURITY', client, { reason: 'REFRESH_TOKEN_REUSE', familyId });
    throw new AppException('AUTH-005', 'Invalid refresh token');
  }

  private async startFamily(user: SessionUser, rememberMe: boolean, client: ClientInfo): Promise<IssuedSession> {
    const token = newRefreshToken();
    const expiresAt = refreshExpiry(new Date(), rememberMe);
    const created = await this.prisma.db.refreshToken.create({
      data: {
        userId: user.id,
        officeId: user.officeId,
        // A new family (session) per login; every rotation stays in it.
        familyId: randomUUID(),
        tokenHash: hashRefreshToken(token),
        expiresAt,
        ipAddress: client.ip,
        userAgent: truncate(client.userAgent),
      },
    });
    return this.issue(user, created.familyId, token, expiresAt);
  }

  private async issue(user: SessionUser, familyId: string, refreshToken: string, refreshExpiresAt: Date): Promise<IssuedSession> {
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
        },
      },
    };
  }

  private async revokeFamily(familyId: string): Promise<void> {
    await this.prisma.db.refreshToken.updateMany({ where: { familyId, revokedAt: null }, data: { revokedAt: new Date() } });
  }

  /** Inactive user → 403 AUTH-006; suspended office → AUTH-006 with its own message (MVP-40 AC). */
  private assertActive(user: SessionUser): void {
    if (!user.isActive) throw new AppException('AUTH-006', 'User account is inactive');
    if (!user.office.isActive) throw new AppException('AUTH-006', 'Office is suspended');
    if (!isRole(user.role)) throw new AppException('AUTH-006', 'User account is inactive');
  }

  /** D-053: 5 failures in 15 min for this email + IP, counted since the last success, lock that pair. */
  private async isLockedOut(email: string, ip: string): Promise<boolean> {
    const windowStart = new Date(Date.now() - LOCKOUT_WINDOW_MS);
    // unscoped: LoginAttempt is global and written before an office is known (D-079).
    const attempts = this.prisma.unscoped().loginAttempt;
    const lastSuccess = await attempts.findFirst({
      where: { email, ipAddress: ip, success: true, attemptedAt: { gte: windowStart } },
      orderBy: { attemptedAt: 'desc' },
      select: { attemptedAt: true },
    });
    const since = lastSuccess?.attemptedAt ?? windowStart;
    const failures = await attempts.count({ where: { email, ipAddress: ip, success: false, attemptedAt: { gt: since } } });
    return failures >= LOCKOUT_MAX_FAILURES;
  }

  private async recordAttempt(email: string, ip: string, success: boolean): Promise<void> {
    // unscoped: see isLockedOut.
    await this.prisma.unscoped().loginAttempt.create({ data: { email, ipAddress: ip, success } });
  }

  private async audit(user: SessionUser, action: AuditAction, client: ClientInfo, details?: Prisma.InputJsonObject): Promise<void> {
    await this.prisma.db.auditLog.create({
      data: {
        officeId: user.officeId,
        userId: user.id,
        entityType: 'User',
        entityId: user.id,
        action,
        newValues: details,
        ipAddress: client.ip,
        userAgent: truncate(client.userAgent),
        requestId: client.requestId,
      },
    });
  }

  private runContext(user: SessionUser, client: ClientInfo) {
    return {
      officeId: user.officeId as OfficeId,
      userId: user.id as UserId,
      ...(client.requestId ? { requestId: client.requestId } : {}),
    };
  }
}

function truncate(value: string | null): string | null {
  return value === null ? null : value.slice(0, MAX_USER_AGENT);
}
