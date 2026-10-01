import { SetMetadata } from '@nestjs/common';
import type { Permission } from '@nexlegtiq/shared-types';

export const PERMISSIONS_KEY = 'nexlegtiq:permissions';
export const CONDITIONS_CHECKED_KEY = 'nexlegtiq:permission-conditions-checked';

export interface PermissionRequirement {
  readonly mode: 'ALL' | 'ANY';
  readonly permissions: readonly Permission[];
}

/** The caller's role must hold every listed permission (D-051). On a class and a method, both must pass (D-081). */
export const RequirePermissions = (...permissions: [Permission, ...Permission[]]): MethodDecorator & ClassDecorator =>
  SetMetadata(PERMISSIONS_KEY, { mode: 'ALL', permissions } satisfies PermissionRequirement);

/**
 * The caller's role must hold at least one listed permission (D-051). List endpoints use it with
 * `view:all:x` | `view:assigned:x`; the service then narrows by which one is held (`caseScope`).
 */
export const RequireAnyPermission = (...permissions: [Permission, ...Permission[]]): MethodDecorator & ClassDecorator =>
  SetMetadata(PERMISSIONS_KEY, { mode: 'ANY', permissions } satisfies PermissionRequirement);

/**
 * Declares that the route's service enforces the conditional matrix cells (PERMISSION_CONDITIONS: a lawyer's
 * close/reopen only as responsible lawyer, a collaborator's complete:task only on own tasks). Without it the guard
 * treats a conditional cell as not held (fail closed, D-081), so forgetting the check cannot over-grant.
 */
export const PermissionConditionsCheckedByService = (): MethodDecorator & ClassDecorator =>
  SetMetadata(CONDITIONS_CHECKED_KEY, true);
