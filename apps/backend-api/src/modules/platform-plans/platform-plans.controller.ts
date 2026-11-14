import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AdminPlanSchema, CreatePlanSchema, UpdatePlanSchema } from '@nexlegtiq/shared-contracts';
import type { AdminPlan, CreatePlanRequest, UpdatePlanRequest } from '@nexlegtiq/shared-contracts';
import type { Request } from 'express';
import { ClsService } from 'nestjs-cls';
import { z } from 'zod';

import { PlatformPlansService } from './platform-plans.service';
import { Public } from '../../common/auth/public.decorator';
import type { RequestContext } from '../../common/context/request-context';
import { ResourceNotFoundException } from '../../common/errors/app.exception';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe';
import { ApiZodBody, ApiZodResponse } from '../../common/openapi/api-zod.decorators';
import { clientFromRequest } from '../auth/client-info';
import type { ClientInfo } from '../auth/client-info';
import { AdminAuthGuard, AdminRealmGuard } from '../platform-auth/admin-guards';

const uuid = () => new ParseUUIDPipe({ exceptionFactory: () => new ResourceNotFoundException() });
const MINUTE_MS = 60_000;
type AdminRequest = Request & { platformAdminId?: string };

/** Platform realm (D-145): the plans offices subscribe to (D-005, D-173). */
@ApiTags('admin')
@ApiBearerAuth('JWT')
@Public()
@UseGuards(AdminRealmGuard, AdminAuthGuard)
@Throttle({ default: { limit: 60, ttl: MINUTE_MS } })
@Controller('admin/plans')
export class PlatformPlansController {
  constructor(
    private readonly plans: PlatformPlansService,
    private readonly cls: ClsService<RequestContext>,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Every plan with how many subscriptions use it' })
  @ApiZodResponse(HttpStatus.OK, z.array(AdminPlanSchema))
  list(): Promise<AdminPlan[]> {
    return this.plans.list();
  }

  @Post()
  @ApiOperation({ summary: 'Create a plan (audited)' })
  @ApiZodBody(CreatePlanSchema)
  @ApiZodResponse(HttpStatus.CREATED, AdminPlanSchema)
  create(
    @Body(new ZodValidationPipe(CreatePlanSchema)) body: CreatePlanRequest,
    @Req() req: AdminRequest,
  ): Promise<AdminPlan> {
    return this.plans.create(body, this.adminId(req), this.client(req));
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Change a plan; offices on it get the new limits at once (audited)' })
  @ApiZodBody(UpdatePlanSchema)
  @ApiZodResponse(HttpStatus.OK, AdminPlanSchema)
  update(
    @Param('id', uuid()) id: string,
    @Body(new ZodValidationPipe(UpdatePlanSchema)) body: UpdatePlanRequest,
    @Req() req: AdminRequest,
  ): Promise<AdminPlan> {
    return this.plans.update(id, body, this.adminId(req), this.client(req));
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a plan no subscription uses (else 422 BIZ-022; audited)' })
  remove(@Param('id', uuid()) id: string, @Req() req: AdminRequest): Promise<void> {
    return this.plans.remove(id, this.adminId(req), this.client(req));
  }

  private adminId(req: AdminRequest): string {
    // AdminAuthGuard always sets it; its absence is a wiring error (500).
    if (!req.platformAdminId) throw new Error('AdminAuthGuard did not run');
    return req.platformAdminId;
  }

  private client(req: Request): ClientInfo {
    return clientFromRequest(req, this.cls.isActive() ? this.cls.getId() : null);
  }
}
