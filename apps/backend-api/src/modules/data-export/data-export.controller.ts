import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  OfficeExportDownloadSchema,
  OfficeExportSchema,
  UserExportSchema,
} from '@nexlegtiq/shared-contracts';
import type { OfficeExport, OfficeExportDownload } from '@nexlegtiq/shared-contracts';
import type { Request } from 'express';
import { ClsService } from 'nestjs-cls';

import { DataExportService } from './data-export.service';
import { ResourceNotFoundException } from '../../common/errors/app.exception';
import { ApiZodResponse } from '../../common/openapi/api-zod.decorators';
import { RequirePermissions } from '../../common/rbac/permissions.decorator';
import { clientFromRequest } from '../auth/client-info';
import { AllowWhenReadOnly } from '../subscriptions/subscription.decorators';

const exportId = new ParseUUIDPipe({ exceptionFactory: () => new ResourceNotFoundException() });

/**
 * Data exports (MVP-106, D-184). Allowed while the office is read-only: an office that stopped paying still owns its
 * data (DPA).
 */
@ApiTags('exports')
@ApiBearerAuth('JWT')
@AllowWhenReadOnly()
@Controller()
export class DataExportController {
  constructor(
    private readonly exports: DataExportService,
    private readonly cls: ClsService,
  ) {}

  @Post('offices/me/export')
  @RequirePermissions('export:office')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 3, ttl: 3_600_000 } })
  @ApiOperation({
    summary:
      "Export the office's data as a ZIP, prepared in the background (202; the one being prepared is returned if any)",
  })
  @ApiZodResponse(HttpStatus.ACCEPTED, OfficeExportSchema)
  request(@Req() req: Request): Promise<OfficeExport> {
    return this.exports.request(this.client(req));
  }

  @Get('offices/me/exports')
  @RequirePermissions('export:office')
  @ApiOperation({ summary: "The office's latest exports, newest first" })
  @ApiZodResponse(HttpStatus.OK, OfficeExportSchema.array())
  list(): Promise<OfficeExport[]> {
    return this.exports.list();
  }

  @Get('offices/me/exports/:id/download')
  @RequirePermissions('export:office')
  @ApiOperation({
    summary: 'A 15-minute link to a ready export (not ready, failed or expired → 422 BIZ-026)',
  })
  @ApiZodResponse(HttpStatus.OK, OfficeExportDownloadSchema)
  download(@Param('id', exportId) id: string, @Req() req: Request): Promise<OfficeExportDownload> {
    return this.exports.download(id, this.client(req));
  }

  @Get('users/me/export')
  @Throttle({ default: { limit: 5, ttl: 3_600_000 } })
  @ApiOperation({
    summary:
      'Your own data (profile, tasks, time, notes, audit rows); the app saves it as a JSON file',
  })
  @ApiZodResponse(HttpStatus.OK, UserExportSchema)
  userExport(@Req() req: Request): Promise<Record<string, unknown>> {
    return this.exports.userExport(this.client(req));
  }

  private client(req: Request) {
    return clientFromRequest(req, this.cls.isActive() ? this.cls.getId() : null);
  }
}
