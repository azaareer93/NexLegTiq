import { Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { PlanFeature } from '@nexlegtiq/shared-contracts';

import type { Entitlements } from './entitlements';
import { EntitlementsService } from './entitlements.service';
import { ALLOW_READ_ONLY_KEY, FEATURE_KEY } from './subscription.decorators';
import type { AuthPrincipal } from '../../common/context/request-context';
import { AppException } from '../../common/errors/app.exception';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** 403 AUTH-105 while a deletion is scheduled (D-251), else 403 AUTH-104 while the subscription has ended (D-122). */
function assertWritable(entitlements: Entitlements): void {
  if (entitlements.deletionScheduledFor) {
    throw new AppException('AUTH-105', 'Deletion scheduled: the office is read-only');
  }
  if (entitlements.readOnly) {
    throw new AppException('AUTH-104', 'Subscription ended: the office is read-only');
  }
}

/**
 * Global guard after PermissionsGuard (D-122): `@RequireFeature` → 403 AUTH-102 unless the plan has the flag; any other
 * method than GET/HEAD/OPTIONS → 403 AUTH-104 while the office's subscription has ended (read-only mode), or AUTH-105
 * while its deletion is scheduled (D-251), unless the route is `@AllowWhenReadOnly()`. Public routes and the platform realm are not concerned; any realm acting for an office
 * (office staff now, portal clients later) is. Entitlements are loaded only when a
 * check applies (a write or a gated route).
 */
@Injectable()
export class SubscriptionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly entitlements: EntitlementsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{ method?: string; user?: AuthPrincipal }>();
    const user = request.user;
    // Public routes have no caller; platform admins act across offices. Office staff and (later) portal clients are
    // bound by their office's subscription.
    if (!user || user.realm === 'PLATFORM') return true;

    const targets = [context.getHandler(), context.getClass()];
    const feature = this.reflector.getAllAndOverride<PlanFeature | undefined>(FEATURE_KEY, targets);
    const write = this.isWrite(request.method, targets);
    if (!feature && !write) return true;

    const entitlements = await this.entitlements.forOffice(user.officeId);
    if (feature && !entitlements.features[feature]) {
      throw new AppException('AUTH-102', `Plan does not include ${feature}`);
    }
    if (write) assertWritable(entitlements);
    return true;
  }

  /** Changes office data: any method but GET/HEAD/OPTIONS, unless the route is `@AllowWhenReadOnly()`. */
  private isWrite(
    method: string | undefined,
    targets: Parameters<Reflector['getAllAndOverride']>[1],
  ) {
    return (
      !SAFE_METHODS.has(method ?? 'GET') &&
      !this.reflector.getAllAndOverride<boolean>(ALLOW_READ_ONLY_KEY, targets)
    );
  }
}
