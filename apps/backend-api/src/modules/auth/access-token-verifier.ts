import { Injectable } from '@nestjs/common';
import { JwtService, TokenExpiredError } from '@nestjs/jwt';
import { isRole } from '@nexlegtiq/shared-types';
import type { OfficeId, UserId } from '@nexlegtiq/shared-types';

import { JWT_AUDIENCE, JWT_ISSUER } from './auth.constants';
import type { AccessTokenClaims } from './auth.constants';
import { isVerificationOverdue } from './email-verification';
import type { AuthPrincipal } from '../../common/context/request-context';
import { AppException } from '../../common/errors/app.exception';
import { DEFAULT_MESSAGE } from '../../common/errors/error-catalog';
import { AppConfig } from '../../config/app-config';
import { PrismaService } from '../../database/prisma.service';

export interface VerifiedAccess {
  readonly principal: AuthPrincipal;
  /** When the access token expires (ms since the epoch). */
  readonly expiresAt: number;
}

/**
 * Who an access token belongs to (D-082), for HTTP (JwtAuthGuard) and the realtime gateway (D-129) alike: HS256,
 * issuer and audience checked, then role, active flags and office status reloaded from the database, so a demotion,
 * deactivation or suspension applies at once. Expired → AUTH-002, anything else wrong → AUTH-003, inactive → AUTH-006,
 * unverified past the deadline (when enforced) → AUTH-010.
 */
@Injectable()
export class AccessTokenVerifier {
  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
  ) {}

  async verify(token: string | undefined): Promise<VerifiedAccess> {
    const claims = await this.claims(token);
    // ponytail: one indexed lookup per request; add an office-tagged cache (o:{officeId}:user:{id}) if it ever shows up.
    // unscoped: authentication itself; the office comes from the verified token and is matched on the row.
    const user = await this.prisma.unscoped().user.findFirst({
      where: { id: claims.sub, officeId: claims.officeId },
      select: {
        role: true,
        isActive: true,
        emailVerifiedAt: true,
        createdAt: true,
        office: { select: { isActive: true } },
      },
    });
    if (!user || !isRole(user.role))
      throw new AppException('AUTH-003', DEFAULT_MESSAGE['AUTH-003']);
    if (!user.isActive) throw new AppException('AUTH-006', 'User account is inactive');
    if (!user.office.isActive) throw new AppException('AUTH-006', 'Office is suspended');
    if (this.config.auth.emailVerificationEnforced && isVerificationOverdue(user, new Date())) {
      throw new AppException('AUTH-010', 'Email address not verified');
    }
    return {
      principal: {
        userId: claims.sub as UserId,
        officeId: claims.officeId as OfficeId,
        role: user.role,
        realm: 'OFFICE',
        ...(typeof claims.sid === 'string' ? { sessionId: claims.sid } : {}),
      },
      expiresAt: (claims.exp ?? 0) * 1000,
    };
  }

  private async claims(token: string | undefined): Promise<AccessTokenClaims & { exp?: number }> {
    if (!token) throw new AppException('AUTH-003', DEFAULT_MESSAGE['AUTH-003']);
    try {
      return await this.jwt.verifyAsync<AccessTokenClaims & { exp?: number }>(token, {
        algorithms: ['HS256'],
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
      });
    } catch (error) {
      if (error instanceof TokenExpiredError)
        throw new AppException('AUTH-002', 'Access token expired');
      throw new AppException('AUTH-003', DEFAULT_MESSAGE['AUTH-003']);
    }
  }
}
