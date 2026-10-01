/**
 * RBAC — the single source of truth (docs/context/auth-rbac.md#permission-matrix, D-051, D-052, D-081).
 * Backend guards, the services' "assigned" scoping and the frontend `useCan` all read this file. Any change here is a
 * security change: the matrix test (permissions.spec.ts) must be updated in the same PR and reviewed.
 */

/** Office roles, same values as the Prisma `Role` enum (asserted in the backend). */
export const ROLES = [
  'OFFICE_MANAGER',
  'SENIOR_LAWYER',
  'LAWYER',
  'PARALEGAL',
  'ADMIN',
  'TRAINEE',
  'EXTERNAL_COLLABORATOR',
] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'view:all:cases',
  'view:assigned:cases',
  'create:case',
  'edit:assigned:case',
  'edit:any:case',
  'close:case',
  'reopen:case',
  'delete:case',
  'manage:clients',
  'upload:document',
  'delete:document',
  'share:document',
  'create:session',
  'edit:session',
  'create:task',
  'assign:task',
  'complete:task',
  'log:time',
  'view:all:invoices',
  'view:assigned:invoices',
  'generate:invoice',
  'mark:invoice:paid',
  'use:ai',
  'view:audit',
  'view:reports',
  'manage:users',
  'manage:office',
  'manage:subscription',
  'export:office',
  'manage:portal-access',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const OM = 'OFFICE_MANAGER';
const SL = 'SENIOR_LAWYER';
const L = 'LAWYER';
const P = 'PARALEGAL';
const A = 'ADMIN';
const T = 'TRAINEE';
const X = 'EXTERNAL_COLLABORATOR';

/** Columns of the matrix in auth-rbac.md, one row per permission. */
const GRANTS: Readonly<Record<Permission, readonly Role[]>> = {
  'view:all:cases': [OM, SL, A],
  'view:assigned:cases': [OM, SL, L, P, A, T, X],
  'create:case': [OM, SL, L, P],
  'edit:assigned:case': [OM, SL, L, P],
  'edit:any:case': [OM, SL],
  'close:case': [OM, SL, L],
  'reopen:case': [OM, SL, L],
  'delete:case': [OM, SL],
  'manage:clients': [OM, SL, L, P, A],
  'upload:document': [OM, SL, L, P, T, X],
  'delete:document': [OM, SL, L],
  'share:document': [OM, SL, L],
  'create:session': [OM, SL, L],
  'edit:session': [OM, SL, L],
  'create:task': [OM, SL, L, P],
  'assign:task': [OM, SL, L, P],
  'complete:task': [OM, SL, L, P, T, X],
  'log:time': [OM, SL, L, P, T],
  'view:all:invoices': [OM, A],
  'view:assigned:invoices': [OM, SL, L, P, A],
  'generate:invoice': [OM, SL, L, A],
  'mark:invoice:paid': [OM, SL, L, A],
  'use:ai': [OM, SL, L, P, T],
  'view:audit': [OM, A],
  'view:reports': [OM, SL, A],
  'manage:users': [OM],
  'manage:office': [OM],
  'manage:subscription': [OM],
  'export:office': [OM],
  'manage:portal-access': [OM, SL, L],
};

/** Role → granted permissions, derived from the matrix rows above. Frozen: the security matrix is not mutable at runtime. */
export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = Object.freeze(
  Object.fromEntries(
    ROLES.map((role) => [role, Object.freeze(PERMISSIONS.filter((permission) => GRANTS[permission].includes(role)))]),
  ) as Record<Role, readonly Permission[]>,
);

/**
 * Conditional cells of the matrix: the role holds the permission only on its own records, and the service must check
 * the condition (the guard alone is not enough). D-052: a lawyer closes/reopens only files where they are the
 * responsible lawyer. An external collaborator completes only tasks assigned to them.
 */
export type PermissionCondition = 'RESPONSIBLE_LAWYER' | 'OWN';
export const PERMISSION_CONDITIONS: Readonly<Partial<Record<Role, Partial<Record<Permission, PermissionCondition>>>>> = {
  LAWYER: { 'close:case': 'RESPONSIBLE_LAWYER', 'reopen:case': 'RESPONSIBLE_LAWYER' },
  EXTERNAL_COLLABORATOR: { 'complete:task': 'OWN' },
};

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/**
 * Permissions of a role; none for anything that is not a known role. Total on purpose: a token or caller may carry
 * an unexpected string, and inherited keys such as "constructor" must never resolve to something truthy.
 */
export function permissionsFor(role: unknown): readonly Permission[] {
  return isRole(role) ? ROLE_PERMISSIONS[role] : [];
}

/** The condition the service must enforce for this role/permission, if the matrix cell is conditional. */
export function conditionFor(role: Role, permission: Permission): PermissionCondition | undefined {
  return isRole(role) && Object.hasOwn(PERMISSION_CONDITIONS, role) ? PERMISSION_CONDITIONS[role]?.[permission] : undefined;
}

/** `@RequirePermissions` semantics (D-051): every permission is held. */
export function hasAllPermissions(held: readonly Permission[], required: readonly Permission[]): boolean {
  return required.every((permission) => held.includes(permission));
}

/** `@RequireAnyPermission` semantics (D-051): at least one permission is held. */
export function hasAnyPermission(held: readonly Permission[], anyOf: readonly Permission[]): boolean {
  return anyOf.some((permission) => held.includes(permission));
}
