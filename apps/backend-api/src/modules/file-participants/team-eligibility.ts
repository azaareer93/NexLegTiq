import type { FileTeamRole } from '@nexlegtiq/shared-types';

import { ResourceNotFoundException, ValidationException } from '../../common/errors/app.exception';
import type { ScopedTransaction } from '../../database/unit-of-work';

/** Office roles that may hold each file role (D-096): a responsible lawyer is a lawyer, a paralegal a PARALEGAL. */
const ELIGIBLE: Record<FileTeamRole, readonly string[] | null> = {
  RESPONSIBLE_LAWYER: ['OFFICE_MANAGER', 'SENIOR_LAWYER', 'LAWYER'],
  PARALEGAL: ['PARALEGAL'],
  MEMBER: null,
};
const ROLE_MESSAGE: Record<FileTeamRole, string> = {
  RESPONSIBLE_LAWYER: 'validation.responsibleLawyer',
  PARALEGAL: 'validation.responsibleParalegal',
  MEMBER: 'validation.teamMember',
};
/**
 * The user is an active colleague whose office role may hold `role`, share-locked until commit so a deactivation or
 * role change (D-124) cannot slip in between. Unknown or another office's → 404 (D-019); otherwise 400 VAL-001.
 */
export async function assertEligible(
  tx: ScopedTransaction,
  officeId: string,
  userId: string,
  role: FileTeamRole,
): Promise<void> {
  const [user] = await tx.$queryRaw<{ role: string; isActive: boolean }[]>`
    SELECT role::text AS role, is_active AS "isActive" FROM users
    WHERE id = ${userId}::uuid AND office_id = ${officeId}::uuid FOR SHARE`;
  if (!user) throw new ResourceNotFoundException();
  const allowed = ELIGIBLE[role];
  if (!user.isActive || (allowed && !allowed.includes(user.role))) {
    throw new ValidationException([{ field: 'userId', message: ROLE_MESSAGE[role] }]);
  }
}
