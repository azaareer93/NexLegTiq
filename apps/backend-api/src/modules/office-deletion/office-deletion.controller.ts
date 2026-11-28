import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  OfficeDeletionStatusSchema,
  RequestOfficeDeletionSchema,
} from '@nexlegtiq/shared-contracts';
import type {
  OfficeDeletionStatus,
  RequestOfficeDeletionRequest,
} from '@nexlegtiq/shared-contracts';
import type { Request } from 'express';
import { ClsService } from 'nestjs-cls';

import { OfficeDeletionService } from './office-deletion.service';
import { clientFromRequest } from '../../common/context/client-info';
import type { ClientInfo } from '../../common/context/client-info';
import type { RequestContext } from '../../common/context/request-context';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe';
import { ApiZodBody, ApiZodResponse } from '../../common/openapi/api-zod.decorators';
import { RequirePermissions } from '../../common/rbac/permissions.decorator';
import { AllowWhenReadOnly } from '../subscriptions/subscription.decorators';

const MINUTE_MS = 60_000;

/**
 * The office's own deletion (MVP-152, D-251), `manage:office` (office managers). Both writes stay open while the office
 * is read-only: leaving and changing one's mind must work whatever the subscription says.
 */
@ApiTags('offices')
@ApiBearerAuth('JWT')
@RequirePermissions('manage:office')
@Controller('offices/me/delete-request')
export class OfficeDeletionController {
  constructor(
    private readonly deletion: OfficeDeletionService,
    private readonly cls: ClsService<RequestContext>,
  ) {}

  @Get()
  @ApiOperation({ summary: "The office's scheduled deletion, if any" })
  @ApiZodResponse(HttpStatus.OK, OfficeDeletionStatusSchema)
  status(): Promise<OfficeDeletionStatus> {
    return this.deletion.status();
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @AllowWhenReadOnly()
  @Throttle({ default: { limit: 5, ttl: MINUTE_MS } })
  @ApiOperation({
    summary:
      'Ask to delete the office (password, plus MFA code when on): read-only now, purged after 30 days (audited)',
  })
  @ApiZodBody(RequestOfficeDeletionSchema)
  @ApiZodResponse(HttpStatus.OK, OfficeDeletionStatusSchema)
  request(
    @Body(new ZodValidationPipe(RequestOfficeDeletionSchema)) body: RequestOfficeDeletionRequest,
    @Req() req: Request,
  ): Promise<OfficeDeletionStatus> {
    return this.deletion.request(body, this.client(req));
  }

  @Post('cancel')
  @HttpCode(HttpStatus.OK)
  @AllowWhenReadOnly()
  @ApiOperation({ summary: 'Cancel the scheduled deletion: writes work again (audited)' })
  @ApiZodResponse(HttpStatus.OK, OfficeDeletionStatusSchema)
  cancel(@Req() req: Request): Promise<OfficeDeletionStatus> {
    return this.deletion.cancel(this.client(req));
  }

  private client(req: Request): ClientInfo {
    return clientFromRequest(req, this.cls.isActive() ? this.cls.getId() : null);
  }
}
