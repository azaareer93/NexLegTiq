import { BlockList } from 'node:net';

import { Inject, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { ClsService } from 'nestjs-cls';
import { PinoLogger } from 'nestjs-pino';

import { ADMIN_AUDIENCE, ADMIN_JWT } from './platform-auth.constants';
import type { AdminAccessClaims } from './platform-auth.constants';
import { PlatformSessions } from './platform-sessions';
import type { RequestContext } from '../../common/context/request-context';
import {
  AppException,
  PermissionDeniedException,
  ResourceNotFoundException,
} from '../../common/errors/app.exception';
import { AppConfig } from '../../config/app-config';
import { parseIpEntry } from '../../config/env.schema';
import { PrismaService } from '../../database/prisma.service';
import { JWT_ISSUER } from '../auth/auth.constants';

/** The allow-list as Node's matcher; an empty list lets every address through. */
export function allowList(entries: readonly string[]): BlockList | null {
  if (entries.length === 0) return null;
  const list = new BlockList();
  for (const entry of entries) {
    const parsed = parseIpEntry(entry);
    if (!parsed) continue; // the env schema refused such entries at boot
    if (parsed.prefix === undefined) list.addAddress(parsed.address, parsed.family);
    else list.addSubnet(parsed.address, parsed.prefix, parsed.family);
  }
  return list;
}

/** IPv4 clients often reach Node as `::ffff:a.b.c.d`; the list is matched on the plain address. */
const plainAddress = (ip: string): string => ip.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '');

/**
 * Every admin route (D-145): the realm is off (404, as if it did not exist) without `ADMIN_JWT_SECRET`, and with
 * `ADMIN_IP_ALLOWLIST` only listed addresses (after TRUST_PROXY_HOPS) get through — 403 AUTH-100 for the rest.
 */
@Injectable()
export class AdminRealmGuard implements CanActivate {
  private readonly list: BlockList | null;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: PinoLogger,
  ) {
    this.list = allowList(config.admin?.ipAllowlist ?? []);
    this.logger.setContext(AdminRealmGuard.name);
  }

  canActivate(context: ExecutionContext): boolean {
    if (!this.config.admin) throw new ResourceNotFoundException();
    if (!this.list) return true;
    const ip = plainAddress(context.switchToHttp().getRequest<Request>().ip ?? '');
    const family = ip.includes(':') ? 'ipv6' : 'ipv4';
    if (ip && this.list.check(ip, family)) return true;
    this.logger.warn({ ip }, 'Admin route refused outside the IP allow-list');
    throw new PermissionDeniedException('Address not allowed for the admin realm');
  }
}

/**
 * A signed-in platform admin (D-145): an access token of the admin audience signed with `ADMIN_JWT_SECRET` (an office token
 * never passes), a session that is still live (signed out → refused at once), an active admin. Sets the PLATFORM realm.
 * Expired → 401 AUTH-002, anything else → AUTH-003, session ended → AUTH-004, inactive → 403 AUTH-006.
 */
@Injectable()
export class AdminAuthGuard implements CanActivate {
  constructor(
    @Inject(ADMIN_JWT) private readonly jwt: JwtService,
    private readonly config: AppConfig,
    private readonly sessions: PlatformSessions,
    private readonly prisma: PrismaService,
    private readonly cls: ClsService<RequestContext>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request & { platformAdminId?: string }>();
    const claims = await this.verify(req.get('authorization'));
    const now = new Date();
    if (!(await this.sessions.live(claims.sid, now))) {
      throw new AppException('AUTH-004', 'Admin session ended');
    }
    // unscoped: platform admins belong to no office (D-079).
    const admin = await this.prisma.unscoped().platformAdmin.findUnique({
      where: { id: claims.sub },
      select: { isActive: true },
    });
    if (!admin?.isActive) throw new AppException('AUTH-006', 'Admin account not active');
    req.platformAdminId = claims.sub;
    this.cls.set('realm', 'PLATFORM');
    this.cls.set('platformAdminId', claims.sub);
    return true;
  }

  private async verify(header: string | undefined): Promise<AdminAccessClaims> {
    const token = /^Bearer (\S+)$/.exec(header ?? '')?.[1];
    const secret = this.config.admin?.jwtSecret;
    if (!token || !secret) throw new AppException('AUTH-003', 'Admin sign-in required');
    try {
      return await this.jwt.verifyAsync<AdminAccessClaims>(token, {
        secret,
        audience: ADMIN_AUDIENCE,
        issuer: JWT_ISSUER,
        algorithms: ['HS256'],
      });
    } catch (error) {
      if ((error as { name?: string }).name === 'TokenExpiredError') {
        throw new AppException('AUTH-002', 'Admin access token expired');
      }
      throw new AppException('AUTH-003', 'Invalid admin access token');
    }
  }
}
