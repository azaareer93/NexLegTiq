import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { DashboardSchema } from '@nexlegtiq/shared-contracts';
import type { Dashboard } from '@nexlegtiq/shared-contracts';

import { DashboardService } from './dashboard.service';
import { ApiZodResponse } from '../../common/openapi/api-zod.decorators';
import { RequireAnyPermission } from '../../common/rbac/permissions.decorator';

/** The signed-in user's dashboard (MVP-96, D-151). Every office role reads its own. */
@ApiTags('dashboard')
@ApiBearerAuth('JWT')
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get()
  @RequireAnyPermission('view:all:cases', 'view:assigned:cases')
  @ApiOperation({
    summary: 'My day: KPIs, hearings, deadlines, recent activity (OM/SL: team workload)',
  })
  @ApiZodResponse(200, DashboardSchema)
  get(): Promise<Dashboard> {
    return this.dashboard.get();
  }
}
