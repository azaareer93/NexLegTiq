import {
  Body,
  Controller,
  Get,
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
  AdminFileTypeQuerySchema,
  AdminFileTypeSchema,
  CreateFileSubTypeSchema,
  CreateFileTypeSchema,
  UpdateFileSubTypeSchema,
  UpdateFileTypeSchema,
} from '@nexlegtiq/shared-contracts';
import type {
  AdminFileType,
  AdminFileTypeQuery,
  CreateFileSubTypeRequest,
  CreateFileTypeRequest,
  UpdateFileSubTypeRequest,
  UpdateFileTypeRequest,
} from '@nexlegtiq/shared-contracts';
import type { Request } from 'express';
import { ClsService } from 'nestjs-cls';
import { z } from 'zod';

import { PlatformFileTypesService } from './platform-file-types.service';
import { Public } from '../../common/auth/public.decorator';
import { clientFromRequest } from '../../common/context/client-info';
import type { ClientInfo } from '../../common/context/client-info';
import type { RequestContext } from '../../common/context/request-context';
import { ResourceNotFoundException } from '../../common/errors/app.exception';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe';
import { ApiZodBody, ApiZodQuery, ApiZodResponse } from '../../common/openapi/api-zod.decorators';
import { AdminAuthGuard, AdminRealmGuard } from '../platform-auth/admin-guards';

const uuid = () => new ParseUUIDPipe({ exceptionFactory: () => new ResourceNotFoundException() });
const MINUTE_MS = 60_000;
type AdminRequest = Request & { platformAdminId?: string };

/**
 * Platform realm (D-145): legal file types and sub-types per country (MVP-175, D-261). No delete: files keep their
 * type, so a type or sub-type is deactivated instead. Each write answers with the whole type.
 */
@ApiTags('admin')
@ApiBearerAuth('JWT')
@Public()
@UseGuards(AdminRealmGuard, AdminAuthGuard)
@Throttle({ default: { limit: 60, ttl: MINUTE_MS } })
@Controller('admin')
export class PlatformFileTypesController {
  constructor(
    private readonly types: PlatformFileTypesService,
    private readonly cls: ClsService<RequestContext>,
  ) {}

  @Get('file-types')
  @ApiOperation({ summary: "A country's file types with every sub-type, in order" })
  @ApiZodQuery(AdminFileTypeQuerySchema)
  @ApiZodResponse(HttpStatus.OK, z.array(AdminFileTypeSchema))
  list(
    @Query(new ZodValidationPipe(AdminFileTypeQuerySchema)) query: AdminFileTypeQuery,
  ): Promise<AdminFileType[]> {
    return this.types.list(query);
  }

  @Post('file-types')
  @ApiOperation({ summary: 'Add a file type to a country (audited; 409 RES-002 for a taken code)' })
  @ApiZodBody(CreateFileTypeSchema)
  @ApiZodResponse(HttpStatus.CREATED, AdminFileTypeSchema)
  create(
    @Body(new ZodValidationPipe(CreateFileTypeSchema)) body: CreateFileTypeRequest,
    @Req() req: AdminRequest,
  ): Promise<AdminFileType> {
    return this.types.create(body, this.adminId(req), this.client(req));
  }

  @Patch('file-types/:id')
  @ApiOperation({ summary: 'Rename, reorder, deactivate or reactivate a file type (audited)' })
  @ApiZodBody(UpdateFileTypeSchema)
  @ApiZodResponse(HttpStatus.OK, AdminFileTypeSchema)
  update(
    @Param('id', uuid()) id: string,
    @Body(new ZodValidationPipe(UpdateFileTypeSchema)) body: UpdateFileTypeRequest,
    @Req() req: AdminRequest,
  ): Promise<AdminFileType> {
    return this.types.update(id, body, this.adminId(req), this.client(req));
  }

  @Post('file-types/:id/sub-types')
  @ApiOperation({
    summary: 'Add a sub-type to a file type (audited; 409 RES-002 for a taken name)',
  })
  @ApiZodBody(CreateFileSubTypeSchema)
  @ApiZodResponse(HttpStatus.CREATED, AdminFileTypeSchema)
  createSubType(
    @Param('id', uuid()) id: string,
    @Body(new ZodValidationPipe(CreateFileSubTypeSchema)) body: CreateFileSubTypeRequest,
    @Req() req: AdminRequest,
  ): Promise<AdminFileType> {
    return this.types.createSubType(id, body, this.adminId(req), this.client(req));
  }

  @Patch('file-sub-types/:id')
  @ApiOperation({ summary: 'Rename, reorder, deactivate or reactivate a sub-type (audited)' })
  @ApiZodBody(UpdateFileSubTypeSchema)
  @ApiZodResponse(HttpStatus.OK, AdminFileTypeSchema)
  updateSubType(
    @Param('id', uuid()) id: string,
    @Body(new ZodValidationPipe(UpdateFileSubTypeSchema)) body: UpdateFileSubTypeRequest,
    @Req() req: AdminRequest,
  ): Promise<AdminFileType> {
    return this.types.updateSubType(id, body, this.adminId(req), this.client(req));
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
