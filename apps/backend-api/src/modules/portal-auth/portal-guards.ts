import { Inject, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { ClsService } from 'nestjs-cls';

import { PortalAccounts } from './portal-accounts';
import { PORTAL_AUDIENCE, PORTAL_JWT } from './portal-auth.constants';
import type { PortalAccessClaims } from './portal-auth.constants';
import { PortalSessions } from './portal-sessions';
import type { RequestContext } from '../../common/context/request-context';
import { AppException, ResourceNotFoundException } from '../../common/errors/app.exception';
import { AppConfig } from '../../config/app-config';
import { PrismaService } from '../../database/prisma.service';
import { JWT_ISSUER } from '../auth/auth.constants';

/** Every portal route: the realm is off (404, as if it did not exist) without `JWT_PORTAL_SECRET` (D-158). */
@Injectable()
export class PortalRealmGuard implements CanActivate {
  constructor(private readonly config: AppConfig) {}

  canActivate(): boolean {
    if (!this.config.portal) throw new ResourceNotFoundException();
    return true;
  }
}

/**
 * A signed-in portal account (D-158): an access token of the portal audience signed with `JWT_PORTAL_SECRET` (an office
 * or admin token never passes), a session that is still live (signed out or revoked → refused at once), an active account
 * with at least one live grant in an active office. Sets the PORTAL realm.
 * Expired → 401 AUTH-002, anything else → AUTH-003, session ended → AUTH-004, no longer active → 403 AUTH-006.
 */
@Injectable()
export class PortalAuthGuard implements CanActivate {
  constructor(
    @Inject(PORTAL_JWT) private readonly jwt: JwtService,
    private readonly config: AppConfig,
    private readonly sessions: PortalSessions,
    private readonly accounts: PortalAccounts,
    private readonly prisma: PrismaService,
    private readonly cls: ClsService<RequestContext>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request & { clientUserId?: string }>();
    const claims = await this.verify(req.get('authorization'));
    if (!(await this.sessions.live(claims.sid, new Date()))) {
      throw new AppException('AUTH-004', 'Portal session ended');
    }
    // unscoped: portal accounts belong to no office.
    const user = await this.prisma.unscoped().clientUser.findUnique({
      where: { id: claims.sub },
      select: { isActive: true },
    });
    if (!user?.isActive || (await this.accounts.offices(claims.sub)).length === 0) {
      throw new AppException('AUTH-006', 'Portal access is not active');
    }
    req.clientUserId = claims.sub;
    this.cls.set('realm', 'PORTAL');
    this.cls.set('clientUserId', claims.sub);
    return true;
  }

  private async verify(header: string | undefined): Promise<PortalAccessClaims> {
    const token = /^Bearer (\S+)$/.exec(header ?? '')?.[1];
    const secret = this.config.portal?.jwtSecret;
    if (!token || !secret) throw new AppException('AUTH-003', 'Portal sign-in required');
    try {
      return await this.jwt.verifyAsync<PortalAccessClaims>(token, {
        secret,
        audience: PORTAL_AUDIENCE,
        issuer: JWT_ISSUER,
        algorithms: ['HS256'],
      });
    } catch (error) {
      if ((error as { name?: string }).name === 'TokenExpiredError') {
        throw new AppException('AUTH-002', 'Portal access token expired');
      }
      throw new AppException('AUTH-003', 'Invalid portal access token');
    }
  }
}
