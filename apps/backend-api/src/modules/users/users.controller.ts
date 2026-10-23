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
  ChangeRoleSchema,
  DeactivateUserSchema,
  DirectoryUserSchema,
  InvitationSchema,
  InviteUserSchema,
  TeamMemberSchema,
  UserOpenFileSchema,
} from '@nexlegtiq/shared-contracts';
import type {
  ChangeRoleRequest,
  DeactivateUserRequest,
  DirectoryUser,
  Invitation,
  InviteUserRequest,
  TeamMember,
  UserOpenFile,
} from '@nexlegtiq/shared-contracts';
import type { Request } from 'express';
import { ClsService } from 'nestjs-cls';

import { InvitationsService } from './invitations.service';
import { TeamService } from './team.service';
import { UsersRepository } from './users.repository';
import type { RequestContext } from '../../common/context/request-context';
import { ResourceNotFoundException } from '../../common/errors/app.exception';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe';
import { ApiZodBody, ApiZodResponse } from '../../common/openapi/api-zod.decorators';
import { RequireAnyPermission, RequirePermissions } from '../../common/rbac/permissions.decorator';
import { clientFromRequest } from '../auth/client-info';
import type { ClientInfo } from '../auth/client-info';

/** A malformed id is the same 404 as an unknown one (D-019). */
const userId = new ParseUUIDPipe({ exceptionFactory: () => new ResourceNotFoundException() });

/** The office's people (api-conventions.md#users): the pickers' directory (D-123) and team management (D-124). */
@ApiTags('users')
@ApiBearerAuth('JWT')
@Controller('users')
export class UsersController {
  constructor(
    private readonly users: UsersRepository,
    private readonly team: TeamService,
    private readonly invitations: InvitationsService,
    private readonly cls: ClsService<RequestContext>,
  ) {}

  /**
   * For the people pickers (D-123): only roles that open files, create or assign tasks, or schedule hearings — not
   * trainees or outside collaborators, who see only their assigned files.
   */
  @Get('directory')
  @RequireAnyPermission('create:case', 'create:task', 'assign:task', 'create:session')
  @ApiOperation({ summary: 'Active colleagues (name and role) for pickers, by name' })
  @ApiZodResponse(HttpStatus.OK, DirectoryUserSchema.array())
  directory(): Promise<DirectoryUser[]> {
    return this.users.directory();
  }

  @Get()
  @RequirePermissions('manage:users')
  @ApiOperation({ summary: 'The office team: active users first, then by name' })
  @ApiZodResponse(HttpStatus.OK, TeamMemberSchema.array())
  list(): Promise<TeamMember[]> {
    return this.team.list();
  }

  @Post('invite')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('manage:users')
  @ApiOperation({
    summary:
      'Invite someone by email with a role (409 RES-002 if the email exists or is invited; 422 BIZ-008 when the plan is full)',
  })
  @ApiZodBody(InviteUserSchema)
  @ApiZodResponse(HttpStatus.CREATED, InvitationSchema)
  invite(
    @Body(new ZodValidationPipe(InviteUserSchema)) body: InviteUserRequest,
    @Req() req: Request,
  ): Promise<Invitation> {
    return this.invitations.invite(body, this.client(req));
  }

  @Get('invitations')
  @RequirePermissions('manage:users')
  @ApiOperation({ summary: 'Pending invitations, newest first (EXPIRED once the link lapsed)' })
  @ApiZodResponse(HttpStatus.OK, InvitationSchema.array())
  listInvitations(): Promise<Invitation[]> {
    return this.invitations.list();
  }

  @Post('invitations/:id/resend')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('manage:users')
  @ApiOperation({ summary: 'Send a pending invitation again with a new 7-day link' })
  @ApiZodResponse(HttpStatus.OK, InvitationSchema)
  resendInvitation(@Param('id', userId) id: string, @Req() req: Request): Promise<Invitation> {
    return this.invitations.resend(id, this.client(req));
  }

  @Delete('invitations/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('manage:users')
  @ApiOperation({ summary: 'Revoke a pending invitation (its link stops working)' })
  @ApiNoContentResponse({ description: 'Revoked' })
  revokeInvitation(@Param('id', userId) id: string, @Req() req: Request): Promise<void> {
    return this.invitations.revoke(id, this.client(req));
  }

  @Get(':id/open-files')
  @RequirePermissions('manage:users')
  @ApiOperation({
    summary: 'Open files the user is responsible for (to reassign before deactivating)',
  })
  @ApiZodResponse(HttpStatus.OK, UserOpenFileSchema.array())
  openFiles(@Param('id', userId) id: string): Promise<UserOpenFile[]> {
    return this.team.openFiles(id);
  }

  @Patch(':id/role')
  @RequirePermissions('manage:users')
  @ApiOperation({ summary: 'Change a role (422 BIZ-001 for the last office manager)' })
  @ApiZodBody(ChangeRoleSchema)
  @ApiZodResponse(HttpStatus.OK, TeamMemberSchema)
  changeRole(
    @Param('id', userId) id: string,
    @Body(new ZodValidationPipe(ChangeRoleSchema)) body: ChangeRoleRequest,
    @Req() req: Request,
  ): Promise<TeamMember> {
    return this.team.changeRole(id, body.role, this.client(req));
  }

  @Post(':id/deactivate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('manage:users')
  @ApiOperation({
    summary: 'Deactivate a user, reassigning every open file they are responsible for',
  })
  @ApiZodBody(DeactivateUserSchema)
  @ApiZodResponse(HttpStatus.OK, TeamMemberSchema)
  deactivate(
    @Param('id', userId) id: string,
    @Body(new ZodValidationPipe(DeactivateUserSchema)) body: DeactivateUserRequest,
    @Req() req: Request,
  ): Promise<TeamMember> {
    return this.team.deactivate(id, body, this.client(req));
  }

  @Post(':id/reactivate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('manage:users')
  @ApiOperation({ summary: 'Reactivate a user (422 BIZ-008 when the plan has no free seat)' })
  @ApiZodResponse(HttpStatus.OK, TeamMemberSchema)
  reactivate(@Param('id', userId) id: string, @Req() req: Request): Promise<TeamMember> {
    return this.team.reactivate(id, this.client(req));
  }

  private client(req: Request): ClientInfo {
    return clientFromRequest(req, this.cls.isActive() ? this.cls.getId() : null);
  }
}
