import { Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  conditionFor,
  hasAllPermissions,
  hasAnyPermission,
  permissionsFor,
} from '@nexlegtiq/shared-types';
import type { Permission } from '@nexlegtiq/shared-types';
import { ClsService } from 'nestjs-cls';
import { PinoLogger } from 'nestjs-pino';

import { CONDITIONS_CHECKED_KEY, PERMISSIONS_KEY } from './permissions.decorator';
import type { PermissionRequirement } from './permissions.decorator';
import { PrismaService } from '../../database/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import type { AuthPrincipal, RequestContext } from '../context/request-context';
import { AppException, PermissionDeniedException } from '../errors/app.exception';
import { DEFAULT_MESSAGE } from '../errors/error-catalog';
import { routeTemplateOf } from '../http/route-template';
import type { RoutedRequest } from '../http/route-template';
import { TenantRunner } from '../tenancy/tenant-runner';

type GuardedRequest = RoutedRequest & {
  user?: AuthPrincipal;
  ip?: string;
  method?: string;
  headers: Record<string, string | string[] | undefined>;
};

const MAX_USER_AGENT = 512;

/**
 * Global guard for `@RequirePermissions` (ALL) / `@RequireAnyPermission` (ANY), D-051 / D-081. Runs after the JWT guard
 * (MVP-40, registered before it), which puts the principal on `req.user`.
 * - Permissions come from the role via the single matrix in shared-types, never from the token.
 * - Only OFFICE-realm principals hold office permissions; portal and platform callers are denied here.
 * - Requirements on the class and on the method must both pass (a method cannot weaken its controller).
 * - Conditional cells count as held only on routes marked `@PermissionConditionsCheckedByService()`.
 * Routes without a requirement are not checked here (authentication is the JWT guard's job).
 * A denial is 403 AUTH-100 plus a best-effort PERMISSION_DENIED audit row in the caller's office.
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
    const targets = [context.getHandler(), context.getClass()];
    const requirements = this.reflector
      .getAll<(PermissionRequirement | undefined)[]>(PERMISSIONS_KEY, targets)
      .filter((requirement): requirement is PermissionRequirement => requirement !== undefined);
    if (requirements.length === 0) return true;

    const request = context.switchToHttp().getRequest<GuardedRequest>();
    const principal = request.user;
    if (!principal) throw new AppException('AUTH-003', DEFAULT_MESSAGE['AUTH-003']);
    if (principal.realm !== 'OFFICE') throw new PermissionDeniedException();

    const conditionsChecked =
      this.reflector.getAllAndOverride<boolean | undefined>(CONDITIONS_CHECKED_KEY, targets) ===
      true;
    const held = this.effectivePermissions(principal, conditionsChecked);
    const denied = requirements.find((requirement) =>
      requirement.mode === 'ALL'
        ? !hasAllPermissions(held, requirement.permissions)
        : !hasAnyPermission(held, requirement.permissions),
    );
    if (!denied) return true;

    await this.auditDenied(principal, denied, request);
    throw new PermissionDeniedException();
  }

  /** The role's permissions, minus conditional cells unless the route declares its service checks them. */
  private effectivePermissions(
    principal: AuthPrincipal,
    conditionsChecked: boolean,
  ): readonly Permission[] {
    const permissions = permissionsFor(principal.role);
    return conditionsChecked
      ? permissions
      : permissions.filter((permission) => !conditionFor(principal.role, permission));
  }

  /** Best effort: a failed audit write is logged but never turns the 403 into a 500. */
  private async auditDenied(
    principal: AuthPrincipal,
    requirement: PermissionRequirement,
    request: GuardedRequest,
  ): Promise<void> {
    const requestId = this.cls.isActive() ? this.cls.getId() : undefined;
    const data: Prisma.AuditLogUncheckedCreateInput = {
      officeId: principal.officeId,
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
      userAgent: firstHeader(request.headers['user-agent'])?.slice(0, MAX_USER_AGENT) ?? null,
      requestId: requestId ?? null,
    };
    try {
      await this.tenant.run(
        { officeId: principal.officeId, userId: principal.userId, requestId },
        () => this.prisma.db.auditLog.create({ data }),
      );
    } catch (error) {
      this.logger.warn({ err: error }, 'Could not audit a permission denial');
    }
  }
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
