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
  CreateJudgeSchema,
  JudgeSchema,
  UpdateJudgeSchema,
} from '@nexlegtiq/shared-contracts';
import type {
  Court,
  CourtQuery,
  CreateJudgeRequest,
  Judge,
  UpdateJudgeRequest,
} from '@nexlegtiq/shared-contracts';
import type { Request } from 'express';
import { ClsService } from 'nestjs-cls';
import { z } from 'zod';

import { CourtsService } from './courts.service';
import { READ_REFERENCE, WRITE_REFERENCE } from './reference-permissions';
import { clientFromRequest } from '../../common/context/client-info';
import type { ClientInfo } from '../../common/context/client-info';
import type { RequestContext } from '../../common/context/request-context';
import { ResourceNotFoundException } from '../../common/errors/app.exception';
import type { PaginatedResult } from '../../common/http/paginated-result';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe';
import { ApiZodBody, ApiZodQuery, ApiZodResponse } from '../../common/openapi/api-zod.decorators';
import { RequireAnyPermission } from '../../common/rbac/permissions.decorator';

/** A malformed id is the same 404 as an unknown one (D-019). */
const uuid = () => new ParseUUIDPipe({ exceptionFactory: () => new ResourceNotFoundException() });

/**
 * Courts and judges (api-conventions.md#courts, MVP-66, D-115, D-266): everyone in the office reads the active platform
 * courts of its country; courts are written by the platform admin only. Whoever opens files or schedules hearings adds
 * the office's own judges (platform judges → 403 on write).
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
  @ApiOperation({ summary: 'Active platform courts of the office country, by Arabic name' })
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
