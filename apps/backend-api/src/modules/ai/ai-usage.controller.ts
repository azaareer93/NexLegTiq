import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AiUsageSummarySchema } from '@nexlegtiq/shared-contracts';
import type { AiUsageSummary } from '@nexlegtiq/shared-contracts';

import { ApiZodResponse } from '../../common/openapi/api-zod.decorators';
import { RequirePermissions } from '../../common/rbac/permissions.decorator';
import { EntitlementsService } from '../subscriptions/entitlements.service';

/** The office's AI quota (D-144), for the AI tab: how many operations are used and left, and when the count restarts. */
@ApiTags('ai')
@ApiBearerAuth('JWT')
@Controller('ai')
export class AiUsageController {
  constructor(private readonly entitlements: EntitlementsService) {}

  @Get('usage')
  @RequirePermissions('use:ai')
  @ApiOperation({
    summary: "This month's AI operations of the office against its plan (office time zone)",
  })
  @ApiZodResponse(200, AiUsageSummarySchema)
  usage(): Promise<AiUsageSummary> {
    return this.entitlements.aiUsage();
  }
}
