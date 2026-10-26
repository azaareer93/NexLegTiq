import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../database/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import { truncateUserAgent } from '../auth/client-info';
import type { ClientInfo } from '../auth/client-info';

export interface PlatformAuditEntry {
  readonly adminId: string | null;
  readonly action: string;
  readonly entityType: string;
  readonly entityId?: string | null;
  readonly targetOfficeId?: string | null;
  readonly oldValues?: Prisma.InputJsonValue;
  readonly newValues?: Prisma.InputJsonValue;
}

type Writer = Pick<Prisma.TransactionClient, 'platformAuditLog'>;

/**
 * What platform admins do (D-145): one append-only row per action, with who, which office it concerned, what changed
 * and the request facts. Admin code is platform code, so it writes through the raw client (D-080).
 */
@Injectable()
export class PlatformAuditService {
  constructor(private readonly prisma: PrismaService) {}

  async log(entry: PlatformAuditEntry, client: ClientInfo, writer?: Writer): Promise<void> {
    // unscoped: the platform audit log belongs to no office.
    const target = writer ?? this.prisma.unscoped();
    await target.platformAuditLog.create({
      data: {
        adminId: entry.adminId,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId ?? null,
        targetOfficeId: entry.targetOfficeId ?? null,
        ...(entry.oldValues !== undefined ? { oldValues: entry.oldValues } : {}),
        ...(entry.newValues !== undefined ? { newValues: entry.newValues } : {}),
        ipAddress: client.ip,
        userAgent: truncateUserAgent(client.userAgent),
        requestId: client.requestId,
      },
    });
  }
}
