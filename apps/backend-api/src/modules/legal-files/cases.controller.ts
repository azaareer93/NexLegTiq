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
  CaseListItemSchema,
  CaseQuerySchema,
  CaseSchema,
  CreateCaseSchema,
  UpdateCaseSchema,
} from '@nexlegtiq/shared-contracts';
import type {
  Case,
  CaseListItem,
  CaseQuery,
  CreateCaseRequest,
  UpdateCaseRequest,
} from '@nexlegtiq/shared-contracts';
import type { Request } from 'express';
import { ClsService } from 'nestjs-cls';

import { CasesService } from './cases.service';
import type { RequestContext } from '../../common/context/request-context';
import { ResourceNotFoundException } from '../../common/errors/app.exception';
import type { PaginatedResult } from '../../common/http/paginated-result';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe';
import { ApiZodBody, ApiZodQuery, ApiZodResponse } from '../../common/openapi/api-zod.decorators';
import { RequireAnyPermission, RequirePermissions } from '../../common/rbac/permissions.decorator';
import { clientFromRequest } from '../auth/client-info';
import type { ClientInfo } from '../auth/client-info';

/** A malformed id is the same 404 as an unknown one (D-019). */
const fileId = new ParseUUIDPipe({ exceptionFactory: () => new ResourceNotFoundException() });

/** Legal files (api-conventions.md#cases, MVP-57, D-096). Every route re-checks access to the file. */
@ApiTags('cases')
@ApiBearerAuth('JWT')
@Controller('cases')
export class CasesController {
  constructor(
    private readonly cases: CasesService,
    private readonly cls: ClsService<RequestContext>,
  ) {}

  @Post()
  @RequirePermissions('create:case')
  @ApiOperation({ summary: 'Open a legal file; the number is generated' })
  @ApiZodBody(CreateCaseSchema)
  @ApiZodResponse(HttpStatus.CREATED, CaseSchema)
  create(
    @Body(new ZodValidationPipe(CreateCaseSchema)) body: CreateCaseRequest,
    @Req() req: Request,
  ): Promise<Case> {
    return this.cases.create(body, this.client(req));
  }

  @Get()
  @RequireAnyPermission('view:all:cases', 'view:assigned:cases')
  @ApiOperation({ summary: 'List the files the caller may see (all, or assigned only)' })
  @ApiZodQuery(CaseQuerySchema)
  @ApiZodResponse(HttpStatus.OK, CaseListItemSchema, { paginated: true })
  list(
    @Query(new ZodValidationPipe(CaseQuerySchema)) query: CaseQuery,
  ): Promise<PaginatedResult<CaseListItem>> {
    return this.cases.list(query);
  }

  @Get(':id')
  @RequireAnyPermission('view:all:cases', 'view:assigned:cases')
  @ApiOperation({ summary: 'A file with its clients, team and counts (404 if not visible)' })
  @ApiZodResponse(HttpStatus.OK, CaseSchema)
  get(@Param('id', fileId) id: string): Promise<Case> {
    return this.cases.get(id);
  }

  @Patch(':id')
  @RequireAnyPermission('edit:any:case', 'edit:assigned:case')
  @ApiOperation({ summary: 'Edit a file (BIZ-007 when archived)' })
  @ApiZodBody(UpdateCaseSchema)
  @ApiZodResponse(HttpStatus.OK, CaseSchema)
  update(
    @Param('id', fileId) id: string,
    @Body(new ZodValidationPipe(UpdateCaseSchema)) body: UpdateCaseRequest,
    @Req() req: Request,
  ): Promise<Case> {
    return this.cases.update(id, body, this.client(req));
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('delete:case')
  @ApiOperation({ summary: 'Soft-delete a file (BIZ-007 when archived)' })
  @ApiNoContentResponse({ description: 'Deleted' })
  remove(@Param('id', fileId) id: string, @Req() req: Request): Promise<void> {
    return this.cases.remove(id, this.client(req));
  }

  private client(req: Request): ClientInfo {
    return clientFromRequest(req, this.cls.isActive() ? this.cls.getId() : null);
  }
}
