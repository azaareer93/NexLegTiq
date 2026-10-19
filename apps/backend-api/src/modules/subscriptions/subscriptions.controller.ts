import { Controller, Get, HttpStatus } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { OfficeSubscriptionSchema } from '@nexlegtiq/shared-contracts';
import type { OfficeSubscription } from '@nexlegtiq/shared-contracts';
import { ClsService } from 'nestjs-cls';

import { EntitlementsService } from './entitlements.service';
import type { RequestContext } from '../../common/context/request-context';
import { ApiZodResponse } from '../../common/openapi/api-zod.decorators';

/**
 * The office's plan, status and usage (api-conventions.md#offices, D-122). Every office user may read the plan and
 * status — the read-only banner depends on them; limits and usage (head count, storage) only `manage:subscription`
 * holders, who see them in Settings.
 */
@ApiTags('offices')
@ApiBearerAuth('JWT')
@Controller('offices/me/subscription')
export class SubscriptionsController {
  constructor(
    private readonly entitlements: EntitlementsService,
    private readonly cls: ClsService<RequestContext>,
  ) {}

  @Get()
  @ApiOperation({ summary: "The office's plan, limits, feature flags and usage" })
  @ApiZodResponse(HttpStatus.OK, OfficeSubscriptionSchema)
  async get(): Promise<OfficeSubscription> {
    const e = await this.entitlements.current();
    const status = {
      plan: e.plan,
      status: e.status,
      readOnly: e.readOnly,
      periodEnd: e.periodEnd?.toISOString() ?? null,
      trialEndsAt: e.trialEndsAt?.toISOString() ?? null,
      features: e.features,
    };
    if (!this.cls.get('permissions')?.includes('manage:subscription')) {
      return { ...status, limits: null, usage: null };
    }
    const [users, storageMb] = await Promise.all([
      this.entitlements.activeUsers(),
      this.entitlements.storageMb(),
    ]);
    return {
      ...status,
      limits: { users: e.maxUsers, storageMb: e.storageQuotaMb, aiMonthly: e.aiQuotaMonthly },
      // AI requests are not recorded yet: the AI usage records join with the AI quota story.
      usage: { users, storageMb, aiThisMonth: 0 },
    };
  }
}
