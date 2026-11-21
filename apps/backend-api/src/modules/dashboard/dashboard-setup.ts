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
  const [client, legalFile, hearing, document, colleague, invitation, aiSummary] =
    await Promise.all([
      db.client.findFirst({ ...one, where: { deletedAt: null } }),
      db.legalFile.findFirst({ ...one, where: { deletedAt: null } }),
      db.session.findFirst({ ...one, where: { isCancelled: false, file: { deletedAt: null } } }),
      db.document.findFirst({ ...one, where: { deletedAt: null } }),
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
