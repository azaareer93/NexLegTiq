import { Controller, Get, HttpStatus } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { OfficeSubscriptionSchema } from '@nexlegtiq/shared-contracts';
import type { OfficeSubscription } from '@nexlegtiq/shared-contracts';

import { EntitlementsService } from './entitlements.service';
import { ApiZodResponse } from '../../common/openapi/api-zod.decorators';

/**
 * The office's plan, status and usage (api-conventions.md#offices, D-122). Every office user may read it — the
 * read-only banner depends on it; only `manage:subscription` holders see the Settings section built on it.
 */
@ApiTags('offices')
@ApiBearerAuth('JWT')
@Controller('offices/me/subscription')
export class SubscriptionsController {
  constructor(private readonly entitlements: EntitlementsService) {}

  @Get()
  @ApiOperation({ summary: "The office's plan, limits, feature flags and usage" })
  @ApiZodResponse(HttpStatus.OK, OfficeSubscriptionSchema)
  async get(): Promise<OfficeSubscription> {
    const [e, users, storageMb] = await Promise.all([
      this.entitlements.current(),
      this.entitlements.activeUsers(),
      this.entitlements.storageMb(),
    ]);
    return {
      plan: e.plan,
      status: e.status,
      readOnly: e.readOnly,
      periodEnd: e.periodEnd?.toISOString() ?? null,
      trialEndsAt: e.trialEndsAt?.toISOString() ?? null,
      limits: { users: e.maxUsers, storageMb: e.storageQuotaMb, aiMonthly: e.aiQuotaMonthly },
      features: e.features,
      // AI requests are not recorded yet: the AI usage records join with the AI quota story.
      usage: { users, storageMb, aiThisMonth: 0 },
    };
  }
}
