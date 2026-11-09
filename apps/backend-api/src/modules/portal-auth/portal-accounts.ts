import { Injectable } from '@nestjs/common';
import type { PortalOfficeAccess } from '@nexlegtiq/shared-contracts';

import { PrismaService } from '../../database/prisma.service';
import type { AuditAction, Prisma } from '../../generated/prisma/client';
import { truncateUserAgent } from '../auth/client-info';
import type { ClientInfo } from '../auth/client-info';

type AuditWriter = Pick<Prisma.TransactionClient, 'auditLog' | 'clientPortalAccess'>;

/**
 * What a portal account may enter (D-157): its live grants in active offices, for live and active clients. Platform
 * code reading tenant rows across offices, so every query is on the raw client with a reason (D-080).
 */
@Injectable()
export class PortalAccounts {
  constructor(private readonly prisma: PrismaService) {}

  async offices(clientUserId: string): Promise<PortalOfficeAccess[]> {
    // unscoped: a portal account spans offices; the grants are the access rule.
    const grants = await this.prisma.unscoped().clientPortalAccess.findMany({
      where: {
        clientUserId,
        revokedAt: null,
        office: { isActive: true },
        client: { deletedAt: null, isActive: true },
      },
      orderBy: { createdAt: 'asc' },
      select: {
        officeId: true,
        clientId: true,
        office: { select: { name: true } },
        client: { select: { displayName: true } },
      },
    });
    return grants.map((grant) => ({
      officeId: grant.officeId,
      officeName: grant.office.name,
      clientId: grant.clientId,
      clientName: grant.client.displayName,
    }));
  }

  /**
   * A sign-in, sign-out or password change of the account: one audit row in every office it has a live grant in (an
   * audit row needs an office; each office sees its own client's activity).
   */
  async audit(
    writer: AuditWriter,
    clientUserId: string,
    action: AuditAction,
    client: ClientInfo,
    newValues?: Prisma.InputJsonObject,
  ): Promise<void> {
    const grants = await writer.clientPortalAccess.findMany({
      where: { clientUserId, revokedAt: null },
      select: { officeId: true },
      distinct: ['officeId'],
    });
    if (grants.length === 0) return;
    await writer.auditLog.createMany({
      data: grants.map(({ officeId }) => ({
        officeId,
        clientUserId,
        entityType: 'ClientUser',
        entityId: clientUserId,
        action,
        ...(newValues && { newValues }),
        ipAddress: client.ip,
        userAgent: truncateUserAgent(client.userAgent),
        requestId: client.requestId,
      })),
    });
  }
}
