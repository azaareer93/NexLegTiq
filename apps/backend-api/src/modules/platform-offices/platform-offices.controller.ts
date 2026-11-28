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
  AdminCancelDeletionSchema,
  AdminOfficeDetailSchema,
  AdminOfficeListItemSchema,
  AdminRescheduleDeletionSchema,
  AdminOfficeQuerySchema,
  ReactivateOfficeSchema,
  SubscriptionActionSchema,
  SuspendOfficeSchema,
} from '@nexlegtiq/shared-contracts';
import type {
  AdminCancelDeletionRequest,
  AdminOfficeDetail,
  AdminOfficeListItem,
  AdminOfficeQuery,
  AdminRescheduleDeletionRequest,
  ReactivateOfficeRequest,
  SubscriptionActionRequest,
  SuspendOfficeRequest,
} from '@nexlegtiq/shared-contracts';
import type { Request } from 'express';
import { ClsService } from 'nestjs-cls';

import { OfficeSubscriptionService } from './office-subscription.service';
import { PlatformOfficesService } from './platform-offices.service';
import { Public } from '../../common/auth/public.decorator';
import { clientFromRequest } from '../../common/context/client-info';
import type { ClientInfo } from '../../common/context/client-info';
import type { RequestContext } from '../../common/context/request-context';
import { ResourceNotFoundException } from '../../common/errors/app.exception';
import type { PaginatedResult } from '../../common/http/paginated-result';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe';
import { ApiZodBody, ApiZodQuery, ApiZodResponse } from '../../common/openapi/api-zod.decorators';
import { OfficeDeletionService } from '../office-deletion/office-deletion.service';
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
    private readonly subscription: OfficeSubscriptionService,
    private readonly deletion: OfficeDeletionService,
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
  get(@Param('id', uuid()) id: string, @Req() req: AdminRequest): Promise<AdminOfficeDetail> {
    return this.offices.view(id, this.adminId(req), this.client(req));
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

  @Post(':id/subscription')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: MINUTE_MS } })
  @ApiOperation({
    summary:
      'Change plan, extend the paid period or start/extend a trial; entitlements apply at once (audited)',
  })
  @ApiZodBody(SubscriptionActionSchema)
  @ApiZodResponse(HttpStatus.OK, AdminOfficeDetailSchema)
  async changeSubscription(
    @Param('id', uuid()) id: string,
    @Body(new ZodValidationPipe(SubscriptionActionSchema)) body: SubscriptionActionRequest,
    @Req() req: AdminRequest,
  ): Promise<AdminOfficeDetail> {
    await this.subscription.apply(id, body, this.adminId(req), this.client(req));
    return this.offices.get(id);
  }

  @Post(':id/deletion/cancel')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: MINUTE_MS } })
  @ApiOperation({ summary: "Cancel an office's scheduled deletion (reason required, audited)" })
  @ApiZodBody(AdminCancelDeletionSchema)
  @ApiZodResponse(HttpStatus.OK, AdminOfficeDetailSchema)
  async cancelDeletion(
    @Param('id', uuid()) id: string,
    @Body(new ZodValidationPipe(AdminCancelDeletionSchema)) body: AdminCancelDeletionRequest,
    @Req() req: AdminRequest,
  ): Promise<AdminOfficeDetail> {
    await this.deletion.adminCancel(id, body.reason.trim(), this.adminId(req), this.client(req));
    return this.offices.get(id);
  }

  @Post(':id/deletion/reschedule')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: MINUTE_MS } })
  @ApiOperation({
    summary:
      "Bring an office's deletion forward on its written request: earlier only, not in the past (audited)",
  })
  @ApiZodBody(AdminRescheduleDeletionSchema)
  @ApiZodResponse(HttpStatus.OK, AdminOfficeDetailSchema)
  async rescheduleDeletion(
    @Param('id', uuid()) id: string,
    @Body(new ZodValidationPipe(AdminRescheduleDeletionSchema))
    body: AdminRescheduleDeletionRequest,
    @Req() req: AdminRequest,
  ): Promise<AdminOfficeDetail> {
    await this.deletion.adminReschedule(
      id,
      new Date(body.scheduledFor),
      body.reason.trim(),
      this.adminId(req),
      this.client(req),
    );
    return this.offices.get(id);
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
