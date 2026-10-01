import type { Permission, UserId } from '@nexlegtiq/shared-types';

import { PermissionDeniedException } from '../errors/app.exception';

/** How much of the office's case data a caller may see (D-051): everything, or only files assigned to them. */
export type CaseScope = { readonly kind: 'ALL' } | { readonly kind: 'ASSIGNED'; readonly userId: UserId };

/**
 * Narrows a `@RequireAnyPermission('view:all:cases', 'view:assigned:cases')` route by the permission actually held.
 * `permissions` are the caller's (CLS, derived from the role).
 */
export function caseScope(permissions: readonly Permission[], userId: UserId): CaseScope {
  if (permissions.includes('view:all:cases')) return { kind: 'ALL' };
  if (permissions.includes('view:assigned:cases')) return { kind: 'ASSIGNED', userId };
  throw new PermissionDeniedException();
}

/**
 * Prisma `where` for "assigned" files (auth-rbac.md, D-051): the caller is the responsible lawyer, the responsible
 * paralegal, or a FileTeamMember. Field names follow domain-model.md#legal-files; LegalFile itself arrives with MVP-57,
 * whose CaseAccessService.assertFileAccess composes this filter with the file id (D-081).
 */
export function assignedFilesWhere(userId: UserId): Record<string, unknown> {
  return {
    OR: [{ responsibleLawyerId: userId }, { responsibleParalegalId: userId }, { teamMembers: { some: { userId } } }],
  };
}

/** The `where` fragment for a scope: nothing for ALL, the assigned filter otherwise. */
export function caseScopeWhere(scope: CaseScope): Record<string, unknown> {
  return scope.kind === 'ALL' ? {} : assignedFilesWhere(scope.userId);
}
