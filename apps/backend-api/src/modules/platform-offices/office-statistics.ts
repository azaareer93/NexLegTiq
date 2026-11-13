import type { AdminOfficeStatistics } from '@nexlegtiq/shared-contracts';

import { daysAgo, STATS_WINDOW_DAYS, WRITE_ACTIONS } from './office-activity';
import type { PrismaClient } from '../../generated/prisma/client';

/** The detail page's counts for one office (D-164): counts only, read on the raw client by the platform realm. */
export async function officeStatistics(
  raw: PrismaClient,
  officeId: string,
  now = new Date(),
): Promise<AdminOfficeStatistics> {
  const since = daysAgo(STATS_WINDOW_DAYS, now);
  const liveFile = { officeId, deletedAt: null };
  const liveDocument = { officeId, deletedAt: null };
  const [signedIn30d, byStatus, filesNew30d, documents, documentsNew30d, writes30d, settings] =
    await Promise.all([
      raw.user.count({ where: { officeId, isActive: true, lastLoginAt: { gte: since } } }),
      raw.legalFile.groupBy({ by: ['status'], where: liveFile, _count: { _all: true } }),
      raw.legalFile.count({ where: { ...liveFile, createdAt: { gte: since } } }),
      raw.document.count({ where: liveDocument }),
      raw.document.count({ where: { ...liveDocument, createdAt: { gte: since } } }),
      raw.auditLog.count({
        where: { officeId, action: { in: [...WRITE_ACTIONS] }, occurredAt: { gte: since } },
      }),
      raw.officeSettings.findUnique({
        where: { officeId },
        select: { enableAi: true, enableOcr: true },
      }),
    ]);
  const filesByStatus = { OPEN: 0, SUSPENDED: 0, CLOSED: 0, ARCHIVED: 0 };
  for (const row of byStatus) filesByStatus[row.status] = row._count._all;
  return {
    signedIn30d,
    filesByStatus,
    filesNew30d,
    documents,
    documentsNew30d,
    writes30d,
    // A missing settings row means the column defaults (both on).
    aiEnabled: settings?.enableAi ?? true,
    ocrEnabled: settings?.enableOcr ?? true,
  };
}
