import type { Permission, Role, UserId } from '@nexlegtiq/shared-types';

import type { Prisma } from '../../generated/prisma/client';
import { PermissionDeniedException } from '../errors/app.exception';

/** How much of the office's case data a caller may see (D-051): everything, or only files assigned to them. */
export interface CaseScope {
  readonly kind: 'ALL' | 'ASSIGNED';
  readonly userId: UserId;
}

/**
 * Narrows a `@RequireAnyPermission('view:all:cases', 'view:assigned:cases')` route by the permission actually held.
 * `permissions` are the caller's (CLS, derived from the role).
 */
export function caseScope(permissions: readonly Permission[], userId: UserId): CaseScope {
  if (permissions.includes('view:all:cases')) return { kind: 'ALL', userId };
  if (permissions.includes('view:assigned:cases')) return { kind: 'ASSIGNED', userId };
  throw new PermissionDeniedException();
}

/**
 * "Assigned" files (auth-rbac.md, D-051): the caller is the responsible lawyer, the responsible paralegal, or a
 * FileTeamMember.
 */
export function assignedFilesWhere(userId: UserId): Prisma.LegalFileWhereInput {
  return {
    OR: [
      { responsibleLawyerId: userId },
      { responsibleParalegalId: userId },
      { teamMembers: { some: { userId } } },
    ],
  };
}

/**
 * The files a scope may see (`deletedAt` aside). A confidential file is visible only to the office manager and to the
 * people assigned to it, also for the other `view:all:cases` roles (D-096).
 */
export function caseScopeWhere(scope: CaseScope, role: Role): Prisma.LegalFileWhereInput {
  if (scope.kind === 'ASSIGNED') return assignedFilesWhere(scope.userId);
  if (role === 'OFFICE_MANAGER') return {};
  return { OR: [{ isConfidential: false }, assignedFilesWhere(scope.userId)] };
}
