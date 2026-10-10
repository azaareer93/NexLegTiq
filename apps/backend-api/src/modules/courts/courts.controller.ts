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
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiNoContentResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  CourtQuerySchema,
  CourtSchema,
  CreateCourtSchema,
  CreateJudgeSchema,
  JudgeSchema,
  UpdateCourtSchema,
  UpdateJudgeSchema,
} from '@nexlegtiq/shared-contracts';
import type {
  Court,
  CourtQuery,
  CreateCourtRequest,
  CreateJudgeRequest,
  Judge,
  UpdateCourtRequest,
  UpdateJudgeRequest,
} from '@nexlegtiq/shared-contracts';
import type { Request } from 'express';
import { ClsService } from 'nestjs-cls';
import { z } from 'zod';

import { CourtsService } from './courts.service';
import { READ_REFERENCE, WRITE_REFERENCE } from './reference-permissions';
import type { RequestContext } from '../../common/context/request-context';
import { ResourceNotFoundException } from '../../common/errors/app.exception';
import type { PaginatedResult } from '../../common/http/paginated-result';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe';
import { ApiZodBody, ApiZodQuery, ApiZodResponse } from '../../common/openapi/api-zod.decorators';
import { RequireAnyPermission } from '../../common/rbac/permissions.decorator';
import { clientFromRequest } from '../auth/client-info';
import type { ClientInfo } from '../auth/client-info';

/** A malformed id is the same 404 as an unknown one (D-019). */
const uuid = () => new ParseUUIDPipe({ exceptionFactory: () => new ResourceNotFoundException() });

/**
 * Courts and judges (api-conventions.md#courts, MVP-66, D-115): platform rows and the office's own. Everyone in the
 * office reads them; whoever opens files or schedules hearings adds the office's own. Platform rows → 403 on write.
 */
@ApiTags('courts')
@ApiBearerAuth('JWT')
@Controller('courts')
export class CourtsController {
  constructor(
    private readonly courts: CourtsService,
    private readonly cls: ClsService<RequestContext>,
  ) {}

  @Get()
  @RequireAnyPermission(...READ_REFERENCE)
  @ApiOperation({ summary: 'Platform courts and the office own, by Arabic name' })
  @ApiZodQuery(CourtQuerySchema)
  @ApiZodResponse(HttpStatus.OK, CourtSchema, { paginated: true })
  list(
    @Query(new ZodValidationPipe(CourtQuerySchema)) query: CourtQuery,
  ): Promise<PaginatedResult<Court>> {
    return this.courts.list(query);
  }

  @Get(':id')
  @RequireAnyPermission(...READ_REFERENCE)
  @ApiOperation({ summary: 'A court' })
  @ApiZodResponse(HttpStatus.OK, CourtSchema)
  get(@Param('id', uuid()) id: string): Promise<Court> {
    return this.courts.get(id);
  }

  @Post()
  @RequireAnyPermission(...WRITE_REFERENCE)
  @ApiOperation({ summary: 'Add an office court' })
  @ApiZodBody(CreateCourtSchema)
  @ApiZodResponse(HttpStatus.CREATED, CourtSchema)
  create(
    @Body(new ZodValidationPipe(CreateCourtSchema)) body: CreateCourtRequest,
    @Req() req: Request,
  ): Promise<Court> {
    return this.courts.create(body, this.caller(req));
  }

  @Patch(':id')
  @RequireAnyPermission(...WRITE_REFERENCE)
  @ApiOperation({ summary: 'Edit an office court (a platform court → 403 AUTH-100)' })
  @ApiZodBody(UpdateCourtSchema)
  @ApiZodResponse(HttpStatus.OK, CourtSchema)
  update(
    @Param('id', uuid()) id: string,
    @Body(new ZodValidationPipe(UpdateCourtSchema)) body: UpdateCourtRequest,
    @Req() req: Request,
  ): Promise<Court> {
    return this.courts.update(id, body, this.caller(req));
  }

  @Delete(':id')
  @RequireAnyPermission(...WRITE_REFERENCE)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete an office court (422 BIZ-011 while files or judges use it)' })
  @ApiNoContentResponse({ description: 'Deleted' })
  remove(@Param('id', uuid()) id: string, @Req() req: Request): Promise<void> {
    return this.courts.remove(id, this.caller(req));
  }

  @Get(':id/judges')
  @RequireAnyPermission(...READ_REFERENCE)
  @ApiOperation({ summary: 'Judges of a court (platform and the office own), active first' })
  @ApiZodResponse(HttpStatus.OK, z.array(JudgeSchema))
  listJudges(@Param('id', uuid()) id: string): Promise<Judge[]> {
    return this.courts.listJudges(id);
  }

  @Post(':id/judges')
  @RequireAnyPermission(...WRITE_REFERENCE)
  @ApiOperation({ summary: 'Add a judge of the office to a court' })
  @ApiZodBody(CreateJudgeSchema)
  @ApiZodResponse(HttpStatus.CREATED, JudgeSchema)
  createJudge(
    @Param('id', uuid()) id: string,
    @Body(new ZodValidationPipe(CreateJudgeSchema)) body: CreateJudgeRequest,
    @Req() req: Request,
  ): Promise<Judge> {
    return this.courts.createJudge(id, body, this.caller(req));
  }

  @Patch(':id/judges/:judgeId')
  @RequireAnyPermission(...WRITE_REFERENCE)
  @ApiOperation({ summary: 'Edit or deactivate an office judge (a platform judge → 403 AUTH-100)' })
  @ApiZodBody(UpdateJudgeSchema)
  @ApiZodResponse(HttpStatus.OK, JudgeSchema)
  updateJudge(
    @Param('id', uuid()) id: string,
    @Param('judgeId', uuid()) judgeId: string,
    @Body(new ZodValidationPipe(UpdateJudgeSchema)) body: UpdateJudgeRequest,
    @Req() req: Request,
  ): Promise<Judge> {
    return this.courts.updateJudge(id, judgeId, body, this.caller(req));
  }

  @Delete(':id/judges/:judgeId')
  @RequireAnyPermission(...WRITE_REFERENCE)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete an office judge (422 BIZ-011 while files name them)' })
  @ApiNoContentResponse({ description: 'Deleted' })
  removeJudge(
    @Param('id', uuid()) id: string,
    @Param('judgeId', uuid()) judgeId: string,
    @Req() req: Request,
  ): Promise<void> {
    return this.courts.removeJudge(id, judgeId, this.caller(req));
  }

  private caller(req: Request): ClientInfo {
    return clientFromRequest(req, this.cls.isActive() ? this.cls.getId() : null);
  }
}
