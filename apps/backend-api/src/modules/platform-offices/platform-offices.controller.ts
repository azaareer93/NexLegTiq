import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  AdminOfficeDetailSchema,
  AdminOfficeListItemSchema,
  AdminOfficeQuerySchema,
  ReactivateOfficeSchema,
  SuspendOfficeSchema,
} from '@nexlegtiq/shared-contracts';
import type {
  AdminOfficeDetail,
  AdminOfficeListItem,
  AdminOfficeQuery,
  ReactivateOfficeRequest,
  SuspendOfficeRequest,
} from '@nexlegtiq/shared-contracts';
import type { Request } from 'express';
import { ClsService } from 'nestjs-cls';

import { PlatformOfficesService } from './platform-offices.service';
import { Public } from '../../common/auth/public.decorator';
import type { RequestContext } from '../../common/context/request-context';
import { ResourceNotFoundException } from '../../common/errors/app.exception';
import type { PaginatedResult } from '../../common/http/paginated-result';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe';
import { ApiZodBody, ApiZodQuery, ApiZodResponse } from '../../common/openapi/api-zod.decorators';
import { clientFromRequest } from '../auth/client-info';
import type { ClientInfo } from '../auth/client-info';
import { AdminAuthGuard, AdminRealmGuard } from '../platform-auth/admin-guards';

const uuid = () => new ParseUUIDPipe({ exceptionFactory: () => new ResourceNotFoundException() });
const MINUTE_MS = 60_000;
type AdminRequest = Request & { platformAdminId?: string };

/** Platform realm (D-145): offices with usage, suspend and reactivate. */
@ApiTags('admin')
@ApiBearerAuth('JWT')
@Public()
@UseGuards(AdminRealmGuard, AdminAuthGuard)
@Controller('admin/offices')
export class PlatformOfficesController {
  constructor(
    private readonly offices: PlatformOfficesService,
    private readonly cls: ClsService<RequestContext>,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Every office with plan and usage, newest first' })
  @ApiZodQuery(AdminOfficeQuerySchema)
  @ApiZodResponse(HttpStatus.OK, AdminOfficeListItemSchema, { paginated: true })
  list(
    @Query(new ZodValidationPipe(AdminOfficeQuerySchema)) query: AdminOfficeQuery,
  ): Promise<PaginatedResult<AdminOfficeListItem>> {
    return this.offices.list(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One office with subscriptions and suspension' })
  @ApiZodResponse(HttpStatus.OK, AdminOfficeDetailSchema)
  get(@Param('id', uuid()) id: string): Promise<AdminOfficeDetail> {
    return this.offices.get(id);
  }

  @Post(':id/suspend')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: MINUTE_MS } })
  @ApiOperation({ summary: 'Suspend an office: sign-ins refused, sessions ended (audited)' })
  @ApiZodBody(SuspendOfficeSchema)
  @ApiZodResponse(HttpStatus.OK, AdminOfficeDetailSchema)
  suspend(
    @Param('id', uuid()) id: string,
    @Body(new ZodValidationPipe(SuspendOfficeSchema)) body: SuspendOfficeRequest,
    @Req() req: AdminRequest,
  ): Promise<AdminOfficeDetail> {
    return this.offices.suspend(id, body.reason.trim(), this.adminId(req), this.client(req));
  }

  @Post(':id/reactivate')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: MINUTE_MS } })
  @ApiOperation({ summary: 'Reactivate a suspended office (audited)' })
  @ApiZodBody(ReactivateOfficeSchema)
  @ApiZodResponse(HttpStatus.OK, AdminOfficeDetailSchema)
  reactivate(
    @Param('id', uuid()) id: string,
    @Body(new ZodValidationPipe(ReactivateOfficeSchema)) body: ReactivateOfficeRequest,
    @Req() req: AdminRequest,
  ): Promise<AdminOfficeDetail> {
    const reason = body.reason?.trim() || undefined;
    return this.offices.reactivate(id, reason, this.adminId(req), this.client(req));
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
