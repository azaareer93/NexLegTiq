import type { TeamMember } from '@nexlegtiq/shared-contracts';
import { isRole } from '@nexlegtiq/shared-types';
import type { Role } from '@nexlegtiq/shared-types';

import { BusinessRuleException, ValidationException } from '../../common/errors/app.exception';
import type { ScopedTransaction } from '../../database/unit-of-work';

/** The rules of team management (D-124), shared by `TeamService`. */
/** Who may be a file's responsible lawyer (D-096). */
export const LAWYER_ROLES: readonly Role[] = ['OFFICE_MANAGER', 'SENIOR_LAWYER', 'LAWYER'];
/** Files that need a responsible lawyer: live and not closed (as BIZ-010 counts them, D-108). */
export const OPEN_FILE = {
  deletedAt: null,
  status: { in: ['OPEN' as const, 'SUSPENDED' as const] },
};

/** A responsible lawyer must hold a lawyer role (D-096): their open files are reassigned first (deactivate wizard). */
export function assertRoleKeepsFiles(counts: { responsibleFiles: number }, role: Role): void {
  if (counts.responsibleFiles > 0 && !LAWYER_ROLES.includes(role)) {
    throw new ValidationException([{ field: 'role', message: 'validation.roleHasOpenFiles' }]);
  }
}

/**
 * A responsible paralegal must be an active PARALEGAL (D-096): leaving that role or the office clears the column on their
 * open files, and their PARALEGAL team row there becomes MEMBER (the role mirrors the column, D-140) — they stay on the
 * team, so a promoted paralegal keeps working on them. Returns how many files changed.
 */
export async function releaseParalegalFiles(
  tx: ScopedTransaction,
  userId: string,
): Promise<number> {
  const { count } = await tx.legalFile.updateMany({
    where: { responsibleParalegalId: userId, ...OPEN_FILE },
    data: { responsibleParalegalId: null },
  });
  await tx.fileTeamMember.updateMany({
    where: { userId, role: 'PARALEGAL', file: OPEN_FILE },
    data: { role: 'MEMBER' },
  });
  return count;
}

export type MemberRow = {
  id: string;
  fullName: string;
  email: string;
  role: string;
  isActive: boolean;
  lastLoginAt: Date | null;
  _count: { responsibleFiles: number };
};

export function present(user: MemberRow): TeamMember | null {
  if (!isRole(user.role)) return null;
  return {
    id: user.id,
    fullName: user.fullName,
    email: user.email,
    role: user.role,
    isActive: user.isActive,
    openFiles: user._count.responsibleFiles,
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
  };
}

/** 422 BIZ-001: the office must keep an active OFFICE_MANAGER. */
export async function assertAnotherManager(tx: ScopedTransaction, userId: string): Promise<void> {
  const others = await tx.user.count({
    where: { role: 'OFFICE_MANAGER', isActive: true, id: { not: userId } },
  });
  if (others === 0) {
    throw new BusinessRuleException('BIZ-001', 'The office must keep an active office manager');
  }
}

export type Reassignment = { fileId: string; newResponsibleLawyerId: string };

/** Exactly the user's open files: a missing one would be left without a lawyer, an extra one is not theirs. */
export function assertCoversAll(
  files: readonly { id: string }[],
  rows: readonly Reassignment[],
): void {
  const open = new Set(files.map((file) => file.id));
  const covered = rows.filter((row) => open.has(row.fileId)).length;
  if (covered !== open.size || rows.length !== open.size) {
    throw new ValidationException([
      { field: 'reassignments', message: 'validation.reassignAllFiles' },
    ]);
  }
}

/** Every new lawyer: an active OM/SL/L of the office, other than the user leaving. */
export async function assertLawyers(
  tx: ScopedTransaction,
  leaving: string,
  rows: readonly Reassignment[],
): Promise<void> {
  const ids = [...new Set(rows.map((row) => row.newResponsibleLawyerId))];
  const valid = await tx.user.findMany({
    where: { id: { in: ids, not: leaving }, isActive: true, role: { in: [...LAWYER_ROLES] } },
    select: { id: true },
  });
  const ok = new Set(valid.map((user) => user.id));
  const details = rows.flatMap((row, index) =>
    ok.has(row.newResponsibleLawyerId)
      ? []
      : [
          {
            field: `reassignments.${index}.newResponsibleLawyerId`,
            message: 'validation.responsibleLawyer',
          },
        ],
  );
  if (details.length > 0) throw new ValidationException(details);
}
