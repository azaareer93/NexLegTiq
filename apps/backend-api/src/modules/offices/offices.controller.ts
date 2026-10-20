import { Body, Controller, Get, HttpStatus, Patch, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  OfficeProfileSchema,
  OfficeSettingsSchema,
  UpdateOfficeProfileSchema,
  UpdateOfficeSettingsSchema,
} from '@nexlegtiq/shared-contracts';
import type {
  OfficeProfile,
  OfficeSettings,
  UpdateOfficeProfileRequest,
  UpdateOfficeSettingsRequest,
} from '@nexlegtiq/shared-contracts';
import type { Request } from 'express';
import { ClsService } from 'nestjs-cls';

import { OfficesService } from './offices.service';
import type { RequestContext } from '../../common/context/request-context';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe';
import { ApiZodBody, ApiZodResponse } from '../../common/openapi/api-zod.decorators';
import { RequirePermissions } from '../../common/rbac/permissions.decorator';
import { clientFromRequest } from '../auth/client-info';
import type { ClientInfo } from '../auth/client-info';

/**
 * The current office's profile and settings (api-conventions.md#offices, MVP-48, D-125): `me`-scoped, so another
 * office is never addressable. Every route needs `manage:office` (OFFICE_MANAGER).
 */
@ApiTags('offices')
@ApiBearerAuth('JWT')
@RequirePermissions('manage:office')
@Controller('offices/me')
export class OfficesController {
  constructor(
    private readonly offices: OfficesService,
    private readonly cls: ClsService<RequestContext>,
  ) {}

  @Get()
  @ApiOperation({ summary: "The office's profile and regional defaults" })
  @ApiZodResponse(HttpStatus.OK, OfficeProfileSchema)
  profile(): Promise<OfficeProfile> {
    return this.offices.profile();
  }

  @Patch()
  @ApiOperation({ summary: "Edit the office's profile (only the fields sent change)" })
  @ApiZodBody(UpdateOfficeProfileSchema)
  @ApiZodResponse(HttpStatus.OK, OfficeProfileSchema)
  updateProfile(
    @Body(new ZodValidationPipe(UpdateOfficeProfileSchema)) body: UpdateOfficeProfileRequest,
    @Req() req: Request,
  ): Promise<OfficeProfile> {
    return this.offices.updateProfile(body, this.caller(req));
  }

  @Get('settings')
  @ApiOperation({
    summary: "The office's defaults: reminders, billing, file numbers, AI/OCR, security",
  })
  @ApiZodResponse(HttpStatus.OK, OfficeSettingsSchema)
  settings(): Promise<OfficeSettings> {
    return this.offices.settings();
  }

  @Patch('settings')
  @ApiOperation({ summary: "Edit the office's settings (only the fields sent change)" })
  @ApiZodBody(UpdateOfficeSettingsSchema)
  @ApiZodResponse(HttpStatus.OK, OfficeSettingsSchema)
  updateSettings(
    @Body(new ZodValidationPipe(UpdateOfficeSettingsSchema)) body: UpdateOfficeSettingsRequest,
    @Req() req: Request,
  ): Promise<OfficeSettings> {
    return this.offices.updateSettings(body, this.caller(req));
  }

  private caller(req: Request): ClientInfo {
    return clientFromRequest(req, this.cls.isActive() ? this.cls.getId() : null);
  }
}
