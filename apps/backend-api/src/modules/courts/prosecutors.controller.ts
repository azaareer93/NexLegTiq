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
  CreateProsecutorSchema,
  ProsecutorQuerySchema,
  ProsecutorSchema,
  UpdateProsecutorSchema,
} from '@nexlegtiq/shared-contracts';
import type {
  CreateProsecutorRequest,
  Prosecutor,
  ProsecutorQuery,
  UpdateProsecutorRequest,
} from '@nexlegtiq/shared-contracts';
import type { Request } from 'express';
import { ClsService } from 'nestjs-cls';

import { ProsecutorsService } from './prosecutors.service';
import { READ_REFERENCE, WRITE_REFERENCE } from './reference-permissions';
import type { RequestContext } from '../../common/context/request-context';
import { ResourceNotFoundException } from '../../common/errors/app.exception';
import type { PaginatedResult } from '../../common/http/paginated-result';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe';
import { ApiZodBody, ApiZodQuery, ApiZodResponse } from '../../common/openapi/api-zod.decorators';
import { RequireAnyPermission } from '../../common/rbac/permissions.decorator';
import { clientFromRequest } from '../auth/client-info';
import type { ClientInfo } from '../auth/client-info';

const uuid = () => new ParseUUIDPipe({ exceptionFactory: () => new ResourceNotFoundException() });

/** The office's public prosecutors (api-conventions.md#courts, MVP-66, D-115). */
@ApiTags('prosecutors')
@ApiBearerAuth('JWT')
@Controller('prosecutors')
export class ProsecutorsController {
  constructor(
    private readonly prosecutors: ProsecutorsService,
    private readonly cls: ClsService<RequestContext>,
  ) {}

  @Get()
  @RequireAnyPermission(...READ_REFERENCE)
  @ApiOperation({ summary: 'The office public prosecutors, by name' })
  @ApiZodQuery(ProsecutorQuerySchema)
  @ApiZodResponse(HttpStatus.OK, ProsecutorSchema, { paginated: true })
  list(
    @Query(new ZodValidationPipe(ProsecutorQuerySchema)) query: ProsecutorQuery,
  ): Promise<PaginatedResult<Prosecutor>> {
    return this.prosecutors.list(query);
  }

  @Get(':id')
  @RequireAnyPermission(...READ_REFERENCE)
  @ApiOperation({ summary: 'A public prosecutor' })
  @ApiZodResponse(HttpStatus.OK, ProsecutorSchema)
  get(@Param('id', uuid()) id: string): Promise<Prosecutor> {
    return this.prosecutors.get(id);
  }

  @Post()
  @RequireAnyPermission(...WRITE_REFERENCE)
  @ApiOperation({ summary: 'Add a public prosecutor' })
  @ApiZodBody(CreateProsecutorSchema)
  @ApiZodResponse(HttpStatus.CREATED, ProsecutorSchema)
  create(
    @Body(new ZodValidationPipe(CreateProsecutorSchema)) body: CreateProsecutorRequest,
    @Req() req: Request,
  ): Promise<Prosecutor> {
    return this.prosecutors.create(body, this.caller(req));
  }

  @Patch(':id')
  @RequireAnyPermission(...WRITE_REFERENCE)
  @ApiOperation({ summary: 'Edit a public prosecutor' })
  @ApiZodBody(UpdateProsecutorSchema)
  @ApiZodResponse(HttpStatus.OK, ProsecutorSchema)
  update(
    @Param('id', uuid()) id: string,
    @Body(new ZodValidationPipe(UpdateProsecutorSchema)) body: UpdateProsecutorRequest,
    @Req() req: Request,
  ): Promise<Prosecutor> {
    return this.prosecutors.update(id, body, this.caller(req));
  }

  @Delete(':id')
  @RequireAnyPermission(...WRITE_REFERENCE)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a public prosecutor' })
  @ApiNoContentResponse({ description: 'Deleted' })
  remove(@Param('id', uuid()) id: string, @Req() req: Request): Promise<void> {
    return this.prosecutors.remove(id, this.caller(req));
  }

  private caller(req: Request): ClientInfo {
    return clientFromRequest(req, this.cls.isActive() ? this.cls.getId() : null);
  }
}
