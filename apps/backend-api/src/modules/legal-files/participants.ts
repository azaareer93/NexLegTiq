import type { CreateCaseRequest } from '@nexlegtiq/shared-contracts';

import { ValidationException } from '../../common/errors/app.exception';
import type { ScopedTransaction } from '../../database/unit-of-work';

const LAWYER_ROLES = ['OFFICE_MANAGER', 'SENIOR_LAWYER', 'LAWYER'] as const;

/** Clients must be live clients of the office; the lawyer and paralegal active users of the right role. */
export async function assertParticipants(
  tx: ScopedTransaction,
  input: CreateCaseRequest,
  officeId: string,
): Promise<void> {
  const [clients, lawyer, paralegal] = await Promise.all([
    tx.client.count({ where: { id: { in: input.clientIds }, deletedAt: null, isActive: true } }),
    lockActiveUser(tx, officeId, input.responsibleLawyerId, LAWYER_ROLES),
    input.responsibleParalegalId
      ? lockActiveUser(tx, officeId, input.responsibleParalegalId, ['PARALEGAL'])
      : Promise.resolve(1),
  ]);
  const details = [
    ...(clients === input.clientIds.length
      ? []
      : [{ field: 'clientIds', message: 'validation.unknownClient' }]),
    ...(lawyer === 1
      ? []
      : [{ field: 'responsibleLawyerId', message: 'validation.responsibleLawyer' }]),
    ...(paralegal === 1
      ? []
      : [{ field: 'responsibleParalegalId', message: 'validation.responsibleParalegal' }]),
  ];
  if (details.length > 0) throw new ValidationException(details);
}

/**
 * 1 when the user is active with one of `roles`, keeping their row share-locked until commit: a deactivation or role
 * change (D-124, which locks the row FOR UPDATE) waits for this file, or this check re-reads the row after it.
 */
async function lockActiveUser(
  tx: ScopedTransaction,
  officeId: string,
  userId: string,
  roles: readonly string[],
): Promise<number> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM users
    WHERE id = ${userId}::uuid AND office_id = ${officeId}::uuid AND is_active AND role::text = ANY(${roles})
    FOR SHARE`;
  return rows.length;
}
