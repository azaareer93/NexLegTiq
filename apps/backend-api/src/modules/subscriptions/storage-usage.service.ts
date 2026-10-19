import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../database/prisma.service';

/**
 * Storage an office uses, for plan quotas (D-005, D-119): the sum of every stored version's size, soft-deleted documents
 * included (their objects stay until purged).
 */
@Injectable()
export class StorageUsageService {
  constructor(private readonly prisma: PrismaService) {}

  // ponytail: a sum per call (a scan of the office's versions via the office_id index); a counter column if uploads ever make it hot.
  async usedBytes(): Promise<bigint> {
    const { _sum } = await this.prisma.db.documentVersion.aggregate({ _sum: { sizeBytes: true } });
    return _sum.sizeBytes ?? 0n;
  }
}
