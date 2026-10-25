import { Injectable } from '@nestjs/common';
import type { OfficeId } from '@nexlegtiq/shared-types';

import type { SubscriptionRow } from './entitlements';
import { PrismaService } from '../../database/prisma.service';

const ROW = {
  status: true,
  currentPeriodEnd: true,
  trialEndsAt: true,
  plan: {
    select: {
      code: true,
      name: true,
      maxUsers: true,
      aiQuotaMonthly: true,
      storageQuotaMb: true,
      features: true,
    },
  },
} as const;

/** Data access for entitlements (D-122). */
@Injectable()
export class SubscriptionsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The office's live subscription (TRIALING/ACTIVE, at most one, D-079), else its newest — as a list for
   * `resolveEntitlements` (empty without any subscription).
   */
  async subscriptionOf(officeId: OfficeId): Promise<SubscriptionRow[]> {
    // unscoped: guards run before TenantInterceptor sets the office; the office id comes from the verified token.
    const raw = this.prisma.unscoped();
    const live = await raw.subscription.findFirst({
      where: { officeId, status: { in: ['TRIALING', 'ACTIVE'] } },
      select: ROW,
    });
    if (live) return [live];
    const newest = await raw.subscription.findFirst({
      where: { officeId },
      orderBy: [{ currentPeriodStart: 'desc' }, { id: 'desc' }],
      select: ROW,
    });
    return newest ? [newest] : [];
  }

  activeUsers(): Promise<number> {
    return this.prisma.db.user.count({ where: { isActive: true } });
  }

  /** Successful AI operations of the office since `monthStart`; cache hits are free (D-130, D-144). */
  aiCallsSince(monthStart: Date): Promise<number> {
    return this.prisma.db.aiUsage.count({
      where: { cached: false, succeeded: true, createdAt: { gte: monthStart } },
    });
  }

  /** The office's IANA time zone (D-125), which decides when its month starts. */
  async officeTimeZone(): Promise<string> {
    const office = await this.prisma.db.office.findFirst({ select: { timezone: true } });
    return office?.timezone ?? 'Asia/Hebron';
  }

  pendingInvitations(now: Date): Promise<number> {
    return this.prisma.db.officeInvitation.count({
      where: { status: 'PENDING', expiresAt: { gt: now } },
    });
  }
}
