import { Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { hasAllPermissions, isRole, matchedPermissions, permissionsFor } from '@nexlegtiq/shared-types';
import { ClsService } from 'nestjs-cls';
import { PinoLogger } from 'nestjs-pino';

import { PrismaService } from '../../database/prisma.service';
import type { AuthPrincipal, RequestContext } from '../context/request-context';
import { AppException, PermissionDeniedException } from '../errors/app.exception';
import { DEFAULT_MESSAGE } from '../errors/error-catalog';
import { routeTemplateOf } from '../http/route-template';
import type { RoutedRequest } from '../http/route-template';
import { TenantRunner } from '../tenancy/tenant-runner';
import { PERMISSIONS_KEY } from './permissions.decorator';
import type { PermissionRequirement } from './permissions.decorator';

type GuardedRequest = RoutedRequest & {
  user?: AuthPrincipal;
  ip?: string;
  method?: string;
  headers: Record<string, string | string[] | undefined>;
};

/**
 * Global guard for `@RequirePermissions` (ALL) / `@RequireAnyPermission` (ANY), D-051. Runs after the JWT guard
 * (MVP-40, registered before it), which puts the principal on `req.user`. Permissions come from the role via the
 * single matrix in shared-types, never from the token (D-081). Routes without either decorator are not checked here.
 * A denial is 403 AUTH-100 plus a PERMISSION_DENIED audit row in the caller's office.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
    private readonly tenant: TenantRunner,
    private readonly cls: ClsService<RequestContext>,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(PermissionsGuard.name);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requirement = this.reflector.getAllAndOverride<PermissionRequirement | undefined>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!requirement) return true;

    const request = context.switchToHttp().getRequest<GuardedRequest>();
    const principal = request.user;
    if (!principal) throw new AppException('AUTH-003', DEFAULT_MESSAGE['AUTH-003']);

    const held = isRole(principal.role) ? permissionsFor(principal.role) : [];
    const allowed =
      requirement.mode === 'ALL'
        ? hasAllPermissions(held, requirement.permissions)
        : matchedPermissions(held, requirement.permissions).length > 0;
    if (allowed) return true;

    await this.auditDenied(principal, requirement, request);
    throw new PermissionDeniedException();
  }

  /** Best effort: a failed audit write is logged but never turns the 403 into a 500. */
  private async auditDenied(principal: AuthPrincipal, requirement: PermissionRequirement, request: GuardedRequest): Promise<void> {
    const requestId = this.cls.isActive() ? this.cls.getId() : undefined;
    try {
      await this.tenant.run({ officeId: principal.officeId, userId: principal.userId, requestId }, () =>
        this.prisma.db.auditLog.create({
          data: {
            userId: principal.userId,
            entityType: 'Route',
            action: 'PERMISSION_DENIED',
            newValues: {
              method: request.method ?? null,
              route: routeTemplateOf(request) ?? null,
              mode: requirement.mode,
              required: [...requirement.permissions],
              role: principal.role,
            },
            ipAddress: request.ip ?? null,
            userAgent: firstHeader(request.headers['user-agent']),
            requestId: requestId ?? null,
          } as never,
        }),
      );
    } catch (error) {
      this.logger.warn({ err: error }, 'Could not audit a permission denial');
    }
  }
}

function firstHeader(value: string | string[] | undefined): string | null {
  return (Array.isArray(value) ? value[0] : value) ?? null;
}
