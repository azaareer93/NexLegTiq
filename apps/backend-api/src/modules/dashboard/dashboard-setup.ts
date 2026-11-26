import type { DashboardSetup } from '@nexlegtiq/shared-contracts';
import type { Permission, UserId } from '@nexlegtiq/shared-types';

import type { PrismaService } from '../../database/prisma.service';

type Db = PrismaService['db'];

/**
 * The quick-start ticks (MVP-109, D-210): has the office ever taken each first step? Office-wide existence checks on the
 * scoped client, yes/no only (like the team counts, confidential files included — nothing of them is shown). Null for
 * callers who do not set up the office (`manage:office`).
 */
export async function officeSetup(
  db: Db,
  userId: UserId,
  permissions: readonly Permission[],
): Promise<DashboardSetup | null> {
  if (!permissions.includes('manage:office')) return null;
  const one = { select: { id: true } } as const;
  // The big tables are ordered by their (officeId, …) index (D-235): without an order, "any row" plans as a table scan,
  // which reads every other office's rows first when this office's sit at the end of the table (a new office).
  const [client, legalFile, hearing, document, colleague, invitation, aiSummary] =
    await Promise.all([
      db.client.findFirst({ ...one, where: { deletedAt: null }, orderBy: { displayName: 'asc' } }),
      db.legalFile.findFirst({
        ...one,
        where: { deletedAt: null },
        orderBy: { responsibleLawyerId: 'asc' },
      }),
      db.session.findFirst({
        ...one,
        where: { isCancelled: false, file: { deletedAt: null } },
        orderBy: { startsAt: 'asc' },
      }),
      db.document.findFirst({ ...one, where: { deletedAt: null }, orderBy: { fileId: 'asc' } }),
      db.user.findFirst({ ...one, where: { id: { not: userId }, isActive: true } }),
      db.officeInvitation.findFirst(one),
      db.aiSummary.findFirst(one),
    ]);
  return {
    client: client !== null,
    case: legalFile !== null,
    hearing: hearing !== null,
    document: document !== null,
    colleague: colleague !== null || invitation !== null,
    aiSummary: aiSummary !== null,
  };
}
