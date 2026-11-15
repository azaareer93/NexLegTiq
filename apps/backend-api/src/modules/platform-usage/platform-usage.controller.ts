import { Controller, Get, HttpStatus, Query, StreamableFile, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  AdminAuditExportQuerySchema,
  AdminAuditPageSchema,
  AdminAuditQuerySchema,
  AdminQueueSchema,
  AdminUsageQuerySchema,
  AdminUsageSchema,
} from '@nexlegtiq/shared-contracts';
import type {
  AdminAuditExportQuery,
  AdminAuditPage,
  AdminAuditQuery,
  AdminQueue,
  AdminUsage,
  AdminUsageQuery,
} from '@nexlegtiq/shared-contracts';

import { PlatformUsageService } from './platform-usage.service';
import { Public } from '../../common/auth/public.decorator';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe';
import { ApiZodQuery, ApiZodResponse } from '../../common/openapi/api-zod.decorators';
import { AdminAuthGuard, AdminRealmGuard } from '../platform-auth/admin-guards';

/** Platform realm (D-145, D-183): usage across offices, queue health and what platform staff did. */
@ApiTags('admin')
@ApiBearerAuth('JWT')
@Public()
@UseGuards(AdminRealmGuard, AdminAuthGuard)
@Controller('admin')
export class PlatformUsageController {
  constructor(private readonly usage: PlatformUsageService) {}

  @Get('usage')
  @ApiOperation({
    summary: 'AI cost per day and per office/model, storage per office, active users, signups',
  })
  @ApiZodQuery(AdminUsageQuerySchema)
  @ApiZodResponse(HttpStatus.OK, AdminUsageSchema)
  get(
    @Query(new ZodValidationPipe(AdminUsageQuerySchema)) query: AdminUsageQuery,
  ): Promise<AdminUsage> {
    return this.usage.usage(query.days);
  }

  @Get('queues')
  @ApiOperation({ summary: 'Job counts per queue (waiting, active, delayed, failed)' })
  @ApiZodResponse(HttpStatus.OK, AdminQueueSchema.array())
  queues(): Promise<AdminQueue[]> {
    return this.usage.queues();
  }

  @Get('audit')
  @ApiOperation({ summary: 'What platform staff did, across offices, newest first' })
  @ApiZodQuery(AdminAuditQuerySchema)
  @ApiZodResponse(HttpStatus.OK, AdminAuditPageSchema)
  audit(
    @Query(new ZodValidationPipe(AdminAuditQuerySchema)) query: AdminAuditQuery,
  ): Promise<AdminAuditPage> {
    return this.usage.audit(query);
  }

  @Get('audit/export')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'The platform audit as CSV (at most 10,000 rows, else 422 BIZ-025)' })
  @ApiProduces('text/csv')
  async export(
    @Query(new ZodValidationPipe(AdminAuditExportQuerySchema)) query: AdminAuditExportQuery,
  ): Promise<StreamableFile> {
    return new StreamableFile(Buffer.from(await this.usage.exportCsv(query), 'utf8'), {
      type: 'text/csv; charset=utf-8',
      disposition: 'attachment; filename="platform-audit.csv"',
    });
  }
}
