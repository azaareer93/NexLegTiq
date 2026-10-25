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
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiNoContentResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AddFileClientSchema,
  AddTeamMemberSchema,
  FileClientSchema,
  FileTeamMemberSchema,
  UpdateFileClientSchema,
  UpdateTeamMemberSchema,
} from '@nexlegtiq/shared-contracts';
import type {
  AddFileClientRequest,
  AddTeamMemberRequest,
  FileClient,
  FileTeamMember,
  UpdateTeamMemberRequest,
} from '@nexlegtiq/shared-contracts';
import type { Request } from 'express';
import { ClsService } from 'nestjs-cls';

import { FileClientsService } from './file-clients.service';
import { FileTeamService } from './file-team.service';
import type { RequestContext } from '../../common/context/request-context';
import { ResourceNotFoundException } from '../../common/errors/app.exception';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe';
import { ApiZodBody, ApiZodResponse } from '../../common/openapi/api-zod.decorators';
import { RequireAnyPermission } from '../../common/rbac/permissions.decorator';
import { clientFromRequest } from '../auth/client-info';
import type { ClientInfo } from '../auth/client-info';

/** A malformed id is the same 404 as an unknown one (D-019). */
const uuid = new ParseUUIDPipe({ exceptionFactory: () => new ResourceNotFoundException() });
const READ = ['view:all:cases', 'view:assigned:cases'] as const;
const EDIT = ['edit:any:case', 'edit:assigned:case'] as const;

const clientOf = (cls: ClsService<RequestContext>, req: Request): ClientInfo =>
  clientFromRequest(req, cls.isActive() ? cls.getId() : null);

/** The clients and the team of a file (api-conventions.md#cases, D-033, D-140). */
@ApiTags('cases')
@ApiBearerAuth('JWT')
@Controller('cases/:id')
export class FileParticipantsController {
  constructor(
    private readonly clients: FileClientsService,
    private readonly team: FileTeamService,
    private readonly cls: ClsService<RequestContext>,
  ) {}

  @Get('clients')
  @RequireAnyPermission(...READ)
  @ApiOperation({ summary: 'The clients of a file, primary first' })
  @ApiZodResponse(HttpStatus.OK, FileClientSchema.array())
  listClients(@Param('id', uuid) fileId: string): Promise<FileClient[]> {
    return this.clients.list(fileId);
  }

  @Post('clients')
  @HttpCode(HttpStatus.CREATED)
  @RequireAnyPermission(...EDIT)
  @ApiOperation({ summary: 'Add a client to a file (409 RES-002 if already there)' })
  @ApiZodBody(AddFileClientSchema)
  @ApiZodResponse(HttpStatus.CREATED, FileClientSchema.array())
  addClient(
    @Param('id', uuid) fileId: string,
    @Body(new ZodValidationPipe(AddFileClientSchema)) body: AddFileClientRequest,
    @Req() req: Request,
  ): Promise<FileClient[]> {
    return this.clients.add(fileId, body, clientOf(this.cls, req));
  }

  @Patch('clients/:clientId')
  @RequireAnyPermission(...EDIT)
  @ApiOperation({ summary: "Make a client the file's primary client" })
  @ApiZodBody(UpdateFileClientSchema)
  @ApiZodResponse(HttpStatus.OK, FileClientSchema.array())
  makePrimary(
    @Param('id', uuid) fileId: string,
    @Param('clientId', uuid) clientId: string,
    @Body(new ZodValidationPipe(UpdateFileClientSchema)) _body: unknown,
    @Req() req: Request,
  ): Promise<FileClient[]> {
    return this.clients.makePrimary(fileId, clientId, clientOf(this.cls, req));
  }

  @Delete('clients/:clientId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireAnyPermission(...EDIT)
  @ApiOperation({ summary: 'Remove a client from a file (the last one stays: 422 BIZ-018)' })
  @ApiNoContentResponse()
  removeClient(
    @Param('id', uuid) fileId: string,
    @Param('clientId', uuid) clientId: string,
    @Req() req: Request,
  ): Promise<void> {
    return this.clients.remove(fileId, clientId, clientOf(this.cls, req));
  }

  @Get('team')
  @RequireAnyPermission(...READ)
  @ApiOperation({ summary: 'The team of a file: responsible lawyer, paralegal, members' })
  @ApiZodResponse(HttpStatus.OK, FileTeamMemberSchema.array())
  listTeam(@Param('id', uuid) fileId: string): Promise<FileTeamMember[]> {
    return this.team.list(fileId);
  }

  @Post('team')
  @HttpCode(HttpStatus.CREATED)
  @RequireAnyPermission(...EDIT)
  @ApiOperation({
    summary:
      'Add a colleague to a file team (RESPONSIBLE_LAWYER reassigns the file: edit:any:case)',
  })
  @ApiZodBody(AddTeamMemberSchema)
  @ApiZodResponse(HttpStatus.CREATED, FileTeamMemberSchema.array())
  addMember(
    @Param('id', uuid) fileId: string,
    @Body(new ZodValidationPipe(AddTeamMemberSchema)) body: AddTeamMemberRequest,
    @Req() req: Request,
  ): Promise<FileTeamMember[]> {
    return this.team.add(fileId, body, clientOf(this.cls, req));
  }

  @Patch('team/:userId')
  @RequireAnyPermission(...EDIT)
  @ApiOperation({ summary: "Change a member's role on a file" })
  @ApiZodBody(UpdateTeamMemberSchema)
  @ApiZodResponse(HttpStatus.OK, FileTeamMemberSchema.array())
  changeRole(
    @Param('id', uuid) fileId: string,
    @Param('userId', uuid) userId: string,
    @Body(new ZodValidationPipe(UpdateTeamMemberSchema)) body: UpdateTeamMemberRequest,
    @Req() req: Request,
  ): Promise<FileTeamMember[]> {
    return this.team.changeRole(fileId, userId, body.role, clientOf(this.cls, req));
  }

  @Delete('team/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireAnyPermission(...EDIT)
  @ApiOperation({
    summary: 'Remove a member from a file team (the responsible lawyer stays: 422 BIZ-019)',
  })
  @ApiNoContentResponse()
  removeMember(
    @Param('id', uuid) fileId: string,
    @Param('userId', uuid) userId: string,
    @Req() req: Request,
  ): Promise<void> {
    return this.team.remove(fileId, userId, clientOf(this.cls, req));
  }
}
