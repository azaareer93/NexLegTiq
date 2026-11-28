import { Body, Controller, HttpStatus, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CourtReportSchema, ReportCourtSchema } from '@nexlegtiq/shared-contracts';
import type { CourtReport, ReportCourtRequest } from '@nexlegtiq/shared-contracts';
import type { Request } from 'express';
import { ClsService } from 'nestjs-cls';

import { CourtReportsService } from './court-reports.service';
import { WRITE_REFERENCE } from './reference-permissions';
import { clientFromRequest } from '../../common/context/client-info';
import type { RequestContext } from '../../common/context/request-context';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe';
import { ApiZodBody, ApiZodResponse } from '../../common/openapi/api-zod.decorators';
import { RequireAnyPermission } from '../../common/rbac/permissions.decorator';

/** "Report a missing court" from the office's court picker (D-266): whoever could have picked a court may report one. */
@ApiTags('courts')
@ApiBearerAuth('JWT')
@Controller('court-reports')
export class CourtReportsController {
  constructor(
    private readonly reports: CourtReportsService,
    private readonly cls: ClsService<RequestContext>,
  ) {}

  @Post()
  @RequireAnyPermission(...WRITE_REFERENCE)
  @ApiOperation({
    summary: 'Report a court missing from the list (the platform admin adds or dismisses it)',
  })
  @ApiZodBody(ReportCourtSchema)
  @ApiZodResponse(HttpStatus.CREATED, CourtReportSchema)
  report(
    @Body(new ZodValidationPipe(ReportCourtSchema)) body: ReportCourtRequest,
    @Req() req: Request,
  ): Promise<CourtReport> {
    return this.reports.report(
      body,
      clientFromRequest(req, this.cls.isActive() ? this.cls.getId() : null),
    );
  }
}
