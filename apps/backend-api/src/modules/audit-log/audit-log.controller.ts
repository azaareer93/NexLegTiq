import { Controller, Get, Param, ParseUUIDPipe, Query, Req, StreamableFile } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  AuditExportQuerySchema,
  AuditPageSchema,
  AuditQuerySchema,
} from '@nexlegtiq/shared-contracts';
import type { AuditExportQuery, AuditPage, AuditQuery } from '@nexlegtiq/shared-contracts';
import type { Request } from 'express';
import { ClsService } from 'nestjs-cls';

import { AuditLogService } from './audit-log.service';
import { clientFromRequest } from '../../common/context/client-info';
import { ResourceNotFoundException } from '../../common/errors/app.exception';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe';
import { ApiZodResponse } from '../../common/openapi/api-zod.decorators';
import { RequirePermissions } from '../../common/rbac/permissions.decorator';

const fileId = new ParseUUIDPipe({ exceptionFactory: () => new ResourceNotFoundException() });

/** The audit log, read (MVP-105, D-180): `view:audit` only. */
@ApiTags('audit')
@ApiBearerAuth('JWT')
@Controller()
export class AuditLogController {
  constructor(
    private readonly audit: AuditLogService,
    private readonly cls: ClsService,
  ) {}

  @Get('audit')
  @RequirePermissions('view:audit')
  @ApiOperation({
    summary: "The office's audit log, newest first, filtered (cursor = last id of the page)",
  })
  @ApiZodResponse(200, AuditPageSchema)
  list(@Query(new ZodValidationPipe(AuditQuerySchema)) query: AuditQuery): Promise<AuditPage> {
    return this.audit.list(query);
  }

  @Get('audit/export')
  @RequirePermissions('view:audit')
  // Each export reads up to 10,000 rows.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary:
      'The filtered audit log as CSV (at most 10,000 rows, else 422 BIZ-025); the export is itself audited',
  })
  @ApiProduces('text/csv')
  async export(
    @Query(new ZodValidationPipe(AuditExportQuerySchema)) query: AuditExportQuery,
    @Req() req: Request,
  ): Promise<StreamableFile> {
    const csv = await this.audit.exportCsv(
      query,
      clientFromRequest(req, this.cls.isActive() ? this.cls.getId() : null),
    );
    return new StreamableFile(Buffer.from(csv, 'utf8'), {
      type: 'text/csv; charset=utf-8',
      disposition: 'attachment; filename="audit-log.csv"',
    });
  }

  @Get('cases/:id/audit')
  @RequirePermissions('view:audit')
  @ApiOperation({
    summary:
      "A file's audit rows: the file and the rows naming it (404 unless the file is visible)",
  })
  @ApiZodResponse(200, AuditPageSchema)
  file(
    @Param('id', fileId) id: string,
    @Query(new ZodValidationPipe(AuditQuerySchema)) query: AuditQuery,
  ): Promise<AuditPage> {
    return this.audit.list(query, id);
  }
}
