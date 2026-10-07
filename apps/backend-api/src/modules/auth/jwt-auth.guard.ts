import { Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService, TokenExpiredError } from '@nestjs/jwt';
import { isRole } from '@nexlegtiq/shared-types';
import type { OfficeId, UserId } from '@nexlegtiq/shared-types';

import { JWT_AUDIENCE, JWT_ISSUER } from './auth.constants';
import type { AccessTokenClaims } from './auth.constants';
import { isVerificationOverdue } from './email-verification';
import { IS_PUBLIC_KEY } from '../../common/auth/public.decorator';
import type { AuthPrincipal } from '../../common/context/request-context';
import { AppException } from '../../common/errors/app.exception';
import { DEFAULT_MESSAGE } from '../../common/errors/error-catalog';
import { AppConfig } from '../../config/app-config';
import { PrismaService } from '../../database/prisma.service';

type AuthenticatedRequest = {
  headers: Record<string, string | string[] | undefined>;
  user?: AuthPrincipal;
};

/**
 * Global, deny-by-default authentication (auth-rbac.md: JwtAuthGuard → PermissionsGuard). Registered before
 * PermissionsGuard. Routes opt out with `@Public()`. The Bearer access token (HS256, 15 min) only identifies the user:
 * role, active flags and office status are reloaded from the database on every request, so a demotion, deactivation or
 * office suspension applies on the next request rather than when the token expires (D-081, D-082). With
 * EMAIL_VERIFICATION_ENFORCED, an email still unverified 7 days after signup is refused with 403 AUTH-010 (D-083).
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (
      this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
        context.getHandler(),
        context.getClass(),
      ])
    )
      return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const claims = await this.verify(bearerToken(request.headers['authorization']));

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

    request.user = {
      userId: claims.sub as UserId,
      officeId: claims.officeId as OfficeId,
      role: user.role,
      realm: 'OFFICE',
      ...(typeof claims.sid === 'string' ? { sessionId: claims.sid } : {}),
    };
    return true;
  }

  private async verify(token: string | undefined): Promise<AccessTokenClaims> {
    if (!token) throw new AppException('AUTH-003', DEFAULT_MESSAGE['AUTH-003']);
    try {
      return await this.jwt.verifyAsync<AccessTokenClaims>(token, {
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

function bearerToken(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  const match = value?.match(/^Bearer\s+(\S+)$/i);
  return match?.[1];
}
