import { SetMetadata } from '@nestjs/common';
import type { Permission } from '@nexlegtiq/shared-types';

export const PERMISSIONS_KEY = 'nexlegtiq:permissions';

export interface PermissionRequirement {
  readonly mode: 'ALL' | 'ANY';
  readonly permissions: readonly Permission[];
}

/** The caller's role must hold every listed permission (D-051). */
export const RequirePermissions = (...permissions: [Permission, ...Permission[]]): MethodDecorator & ClassDecorator =>
  SetMetadata(PERMISSIONS_KEY, { mode: 'ALL', permissions } satisfies PermissionRequirement);

/**
 * The caller's role must hold at least one listed permission (D-051). List endpoints use it with
 * `view:all:x` | `view:assigned:x`; the service then narrows by which one is held (`caseScope`).
 */
export const RequireAnyPermission = (...permissions: [Permission, ...Permission[]]): MethodDecorator & ClassDecorator =>
  SetMetadata(PERMISSIONS_KEY, { mode: 'ANY', permissions } satisfies PermissionRequirement);
