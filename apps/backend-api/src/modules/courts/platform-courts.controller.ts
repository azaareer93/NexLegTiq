import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  AddReportedCourtSchema,
  AdminCourtQuerySchema,
  AdminCourtReportQuerySchema,
  AdminCourtReportSchema,
  AdminOfficeCourtQuerySchema,
  CourtSchema,
  CreateCourtSchema,
  DismissCourtReportSchema,
  OfficeCourtSchema,
  PromoteOfficeCourtSchema,
  ReplaceOfficeCourtResultSchema,
  ReplaceOfficeCourtSchema,
  UpdateCourtSchema,
} from '@nexlegtiq/shared-contracts';
import type {
  AddReportedCourtRequest,
  AdminCourtQuery,
  AdminCourtReport,
  AdminCourtReportQuery,
  AdminOfficeCourtQuery,
  Court,
  CreateCourtRequest,
  DismissCourtReportRequest,
  OfficeCourt,
  PromoteOfficeCourtRequest,
  ReplaceOfficeCourtRequest,
  ReplaceOfficeCourtResult,
  UpdateCourtRequest,
} from '@nexlegtiq/shared-contracts';
import type { Request } from 'express';
import { ClsService } from 'nestjs-cls';

import { PlatformCourtReportsService } from './platform-court-reports.service';
import { PlatformCourtsService } from './platform-courts.service';
import { Public } from '../../common/auth/public.decorator';
import { clientFromRequest } from '../../common/context/client-info';
import type { ClientInfo } from '../../common/context/client-info';
import type { RequestContext } from '../../common/context/request-context';
import { ResourceNotFoundException } from '../../common/errors/app.exception';
import type { PaginatedResult } from '../../common/http/paginated-result';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe';
import { ApiZodBody, ApiZodQuery, ApiZodResponse } from '../../common/openapi/api-zod.decorators';
import { AdminAuthGuard, AdminRealmGuard } from '../platform-auth/admin-guards';

const uuid = () => new ParseUUIDPipe({ exceptionFactory: () => new ResourceNotFoundException() });
const MINUTE_MS = 60_000;
type AdminRequest = Request & { platformAdminId?: string };

/**
 * Platform realm (D-145): courts per country, offices' legacy courts and missing-court reports (MVP-167, D-266). The
 * realm is the permission — every platform admin manages courts; no office token reaches these routes.
 */
@ApiTags('admin')
@ApiBearerAuth('JWT')
@Public()
@UseGuards(AdminRealmGuard, AdminAuthGuard)
@Throttle({ default: { limit: 60, ttl: MINUTE_MS } })
@Controller('admin')
export class PlatformCourtsController {
  constructor(
    private readonly courts: PlatformCourtsService,
    private readonly reports: PlatformCourtReportsService,
    private readonly cls: ClsService<RequestContext>,
  ) {}

  @Get('courts')
  @ApiOperation({ summary: "A country's platform courts (inactive included), by Arabic name" })
  @ApiZodQuery(AdminCourtQuerySchema)
  @ApiZodResponse(HttpStatus.OK, CourtSchema, { paginated: true })
  list(
    @Query(new ZodValidationPipe(AdminCourtQuerySchema)) query: AdminCourtQuery,
  ): Promise<PaginatedResult<Court>> {
    return this.courts.list(query);
  }

  @Post('courts')
  @ApiOperation({ summary: 'Add a platform court (audited; 409 RES-002 for a taken English name)' })
  @ApiZodBody(CreateCourtSchema)
  @ApiZodResponse(HttpStatus.CREATED, CourtSchema)
  create(
    @Body(new ZodValidationPipe(CreateCourtSchema)) body: CreateCourtRequest,
    @Req() req: AdminRequest,
  ): Promise<Court> {
    return this.courts.create(body, this.adminId(req), this.client(req));
  }

  @Patch('courts/:id')
  @ApiOperation({ summary: 'Edit, deactivate or reactivate a platform court (audited)' })
  @ApiZodBody(UpdateCourtSchema)
  @ApiZodResponse(HttpStatus.OK, CourtSchema)
  update(
    @Param('id', uuid()) id: string,
    @Body(new ZodValidationPipe(UpdateCourtSchema)) body: UpdateCourtRequest,
    @Req() req: AdminRequest,
  ): Promise<Court> {
    return this.courts.update(id, body, this.adminId(req), this.client(req));
  }

  @Get('office-courts')
  @ApiOperation({ summary: "Offices' own courts with their office and usage" })
  @ApiZodQuery(AdminOfficeCourtQuerySchema)
  @ApiZodResponse(HttpStatus.OK, OfficeCourtSchema, { paginated: true })
  listOfficeCourts(
    @Query(new ZodValidationPipe(AdminOfficeCourtQuerySchema)) query: AdminOfficeCourtQuery,
  ): Promise<PaginatedResult<OfficeCourt>> {
    return this.courts.listOfficeCourts(query);
  }

  @Post('office-courts/:id/replace')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Re-point an office court to a platform court of its country and delete it (audited)',
  })
  @ApiZodBody(ReplaceOfficeCourtSchema)
  @ApiZodResponse(HttpStatus.OK, ReplaceOfficeCourtResultSchema)
  replace(
    @Param('id', uuid()) id: string,
    @Body(new ZodValidationPipe(ReplaceOfficeCourtSchema)) body: ReplaceOfficeCourtRequest,
    @Req() req: AdminRequest,
  ): Promise<ReplaceOfficeCourtResult> {
    return this.courts.replace(id, body.courtId, this.adminId(req), this.client(req));
  }

  @Post('office-courts/:id/promote')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Turn an office court into a platform court (audited)' })
  @ApiZodBody(PromoteOfficeCourtSchema)
  @ApiZodResponse(HttpStatus.OK, CourtSchema)
  promote(
    @Param('id', uuid()) id: string,
    @Body(new ZodValidationPipe(PromoteOfficeCourtSchema)) body: PromoteOfficeCourtRequest,
    @Req() req: AdminRequest,
  ): Promise<Court> {
    return this.courts.promote(id, body, this.adminId(req), this.client(req));
  }

  @Get('court-reports')
  @ApiOperation({ summary: 'Courts offices reported missing, oldest first' })
  @ApiZodQuery(AdminCourtReportQuerySchema)
  @ApiZodResponse(HttpStatus.OK, AdminCourtReportSchema, { paginated: true })
  listReports(
    @Query(new ZodValidationPipe(AdminCourtReportQuerySchema)) query: AdminCourtReportQuery,
  ): Promise<PaginatedResult<AdminCourtReport>> {
    return this.reports.list(query);
  }

  @Post('court-reports/:id/add')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Add the reported court to the office's country (once: 422 BIZ-029; office notified)",
  })
  @ApiZodBody(AddReportedCourtSchema)
  @ApiZodResponse(HttpStatus.OK, AdminCourtReportSchema)
  addReported(
    @Param('id', uuid()) id: string,
    @Body(new ZodValidationPipe(AddReportedCourtSchema)) body: AddReportedCourtRequest,
    @Req() req: AdminRequest,
  ): Promise<AdminCourtReport> {
    return this.reports.add(id, body, this.adminId(req), this.client(req));
  }

  @Post('court-reports/:id/dismiss')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Dismiss a court report (once: 422 BIZ-029; office notified)' })
  @ApiZodBody(DismissCourtReportSchema)
  @ApiZodResponse(HttpStatus.OK, AdminCourtReportSchema)
  dismiss(
    @Param('id', uuid()) id: string,
    @Body(new ZodValidationPipe(DismissCourtReportSchema)) body: DismissCourtReportRequest,
    @Req() req: AdminRequest,
  ): Promise<AdminCourtReport> {
    return this.reports.dismiss(id, body, this.adminId(req), this.client(req));
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
