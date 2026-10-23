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
  AddFilePartyResultSchema,
  AddFilePartySchema,
  ConflictQuerySchema,
  ConflictSchema,
  FilePartySchema,
  PartyQuerySchema,
  PartySchema,
  ResolveConflictSchema,
  UpdateFilePartySchema,
} from '@nexlegtiq/shared-contracts';
import type {
  AddFilePartyRequest,
  AddFilePartyResult,
  Conflict,
  ConflictQuery,
  FileParty,
  Party,
  PartyQuery,
  ResolveConflictRequest,
  UpdateFilePartyRequest,
} from '@nexlegtiq/shared-contracts';
import type { Request } from 'express';
import { ClsService } from 'nestjs-cls';

import { ConflictsService } from './conflicts.service';
import { PartiesService } from './parties.service';
import { PartyRegistry } from './party-registry';
import type { RequestContext } from '../../common/context/request-context';
import { ResourceNotFoundException } from '../../common/errors/app.exception';
import type { PaginatedResult } from '../../common/http/paginated-result';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe';
import { ApiZodBody, ApiZodQuery, ApiZodResponse } from '../../common/openapi/api-zod.decorators';
import { RequireAnyPermission } from '../../common/rbac/permissions.decorator';
import { clientFromRequest } from '../auth/client-info';
import type { ClientInfo } from '../auth/client-info';

/** A malformed id is the same 404 as an unknown one (D-019). */
const uuid = new ParseUUIDPipe({ exceptionFactory: () => new ResourceNotFoundException() });
const READ = ['view:all:cases', 'view:assigned:cases'] as const;
const EDIT = ['edit:any:case', 'edit:assigned:case'] as const;

const clientOf = (cls: ClsService<RequestContext>, req: Request): ClientInfo =>
  clientFromRequest(req, cls.isActive() ? cls.getId() : null);

/** The party registry and the parties of a file (api-conventions.md#parties, W9, D-135). */
@ApiTags('parties')
@ApiBearerAuth('JWT')
@Controller()
export class PartiesController {
  constructor(
    private readonly parties: PartiesService,
    private readonly registry: PartyRegistry,
    private readonly cls: ClsService<RequestContext>,
  ) {}

  @Get('parties')
  @RequireAnyPermission(...READ)
  @ApiOperation({
    summary: 'Find parties to reuse: Arabic-normalised name, or an exact national or tax id',
  })
  @ApiZodQuery(PartyQuerySchema)
  @ApiZodResponse(HttpStatus.OK, PartySchema.array())
  search(@Query(new ZodValidationPipe(PartyQuerySchema)) query: PartyQuery): Promise<Party[]> {
    return this.registry.search(query);
  }

  @Get('cases/:id/parties')
  @RequireAnyPermission(...READ)
  @ApiOperation({ summary: 'The parties of a file, with their identifiers and notes' })
  @ApiZodResponse(HttpStatus.OK, FilePartySchema.array())
  list(@Param('id', uuid) fileId: string): Promise<FileParty[]> {
    return this.parties.listForFile(fileId);
  }

  @Post('cases/:id/parties')
  @HttpCode(HttpStatus.CREATED)
  @RequireAnyPermission(...EDIT)
  @ApiOperation({
    summary: 'Add an existing or new party to a file; the answer lists any conflicts of interest',
  })
  @ApiZodBody(AddFilePartySchema)
  @ApiZodResponse(HttpStatus.CREATED, AddFilePartyResultSchema)
  add(
    @Param('id', uuid) fileId: string,
    @Body(new ZodValidationPipe(AddFilePartySchema)) body: AddFilePartyRequest,
    @Req() req: Request,
  ): Promise<AddFilePartyResult> {
    return this.parties.add(fileId, body, clientOf(this.cls, req));
  }

  @Patch('cases/:id/parties/:filePartyId')
  @RequireAnyPermission(...EDIT)
  @ApiOperation({ summary: "Change a party's type or role label on a file (re-checks conflicts)" })
  @ApiZodBody(UpdateFilePartySchema)
  @ApiZodResponse(HttpStatus.OK, AddFilePartyResultSchema)
  update(
    @Param('id', uuid) fileId: string,
    @Param('filePartyId', uuid) filePartyId: string,
    @Body(new ZodValidationPipe(UpdateFilePartySchema)) body: UpdateFilePartyRequest,
    @Req() req: Request,
  ): Promise<AddFilePartyResult> {
    return this.parties.update(fileId, filePartyId, body, clientOf(this.cls, req));
  }

  @Delete('cases/:id/parties/:filePartyId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireAnyPermission(...EDIT)
  @ApiOperation({ summary: 'Take a party off a file (the party stays in the registry)' })
  @ApiNoContentResponse({ description: 'Removed' })
  remove(
    @Param('id', uuid) fileId: string,
    @Param('filePartyId', uuid) filePartyId: string,
    @Req() req: Request,
  ): Promise<void> {
    return this.parties.remove(fileId, filePartyId, clientOf(this.cls, req));
  }
}

/** Conflicts of interest found when parties are added (W9, D-135). */
@ApiTags('conflicts')
@ApiBearerAuth('JWT')
@Controller('conflicts')
export class ConflictsController {
  constructor(
    private readonly conflicts: ConflictsService,
    private readonly cls: ClsService<RequestContext>,
  ) {}

  @Get()
  @RequireAnyPermission(...READ)
  @ApiOperation({ summary: 'Conflicts on files the caller can open, newest first' })
  @ApiZodQuery(ConflictQuerySchema)
  @ApiZodResponse(HttpStatus.OK, ConflictSchema, { paginated: true })
  list(
    @Query(new ZodValidationPipe(ConflictQuerySchema)) query: ConflictQuery,
  ): Promise<PaginatedResult<Conflict>> {
    return this.conflicts.list(query);
  }

  @Patch(':id/resolve')
  @RequireAnyPermission(...EDIT)
  @ApiOperation({ summary: 'Resolve a conflict with a note (422 BIZ-017 if already resolved)' })
  @ApiZodBody(ResolveConflictSchema)
  @ApiZodResponse(HttpStatus.OK, ConflictSchema)
  resolve(
    @Param('id', uuid) id: string,
    @Body(new ZodValidationPipe(ResolveConflictSchema)) body: ResolveConflictRequest,
    @Req() req: Request,
  ): Promise<Conflict> {
    return this.conflicts.resolve(id, body.notes, clientOf(this.cls, req));
  }
}
