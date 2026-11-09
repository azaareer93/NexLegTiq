import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiNoContentResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  CreatePortalInvitationSchema,
  PortalInvitationSchema,
  PortalUsersSchema,
} from '@nexlegtiq/shared-contracts';
import type {
  CreatePortalInvitationRequest,
  PortalInvitation,
  PortalUsers,
} from '@nexlegtiq/shared-contracts';
import type { Request } from 'express';
import { ClsService } from 'nestjs-cls';

import { PortalAccessService } from './portal-access.service';
import type { RequestContext } from '../../common/context/request-context';
import { ResourceNotFoundException } from '../../common/errors/app.exception';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe';
import { ApiZodBody, ApiZodResponse } from '../../common/openapi/api-zod.decorators';
import { RequirePermissions } from '../../common/rbac/permissions.decorator';
import { clientFromRequest } from '../auth/client-info';
import type { ClientInfo } from '../auth/client-info';
import { AllowWhenReadOnly, RequireFeature } from '../subscriptions/subscription.decorators';

/** A malformed id is the same 404 as an unknown one (D-019). */
const uuid = () => new ParseUUIDPipe({ exceptionFactory: () => new ResourceNotFoundException() });

/** A client's portal users and invitations (D-158), for staff holding `manage:portal-access`, on plans with the portal. */
@ApiTags('clients')
@ApiBearerAuth('JWT')
@RequirePermissions('manage:portal-access')
@Controller('clients/:clientId')
export class PortalAccessController {
  constructor(
    private readonly access: PortalAccessService,
    private readonly cls: ClsService<RequestContext>,
  ) {}

  @Post('portal-invitations')
  @RequireFeature('clientPortal')
  @ApiOperation({ summary: 'Invite a person of this client to the client portal' })
  @ApiZodBody(CreatePortalInvitationSchema)
  @ApiZodResponse(HttpStatus.CREATED, PortalInvitationSchema)
  invite(
    @Param('clientId', uuid()) clientId: string,
    @Body(new ZodValidationPipe(CreatePortalInvitationSchema)) body: CreatePortalInvitationRequest,
    @Req() req: Request,
  ): Promise<PortalInvitation> {
    return this.access.invite(clientId, body, this.client(req));
  }

  // Revoking stays possible after the plan lapsed or the office is read-only: access must always be removable.
  @Delete('portal-invitations/:invitationId')
  @AllowWhenReadOnly()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Withdraw a pending portal invitation' })
  @ApiNoContentResponse({ description: 'Withdrawn' })
  revokeInvitation(
    @Param('clientId', uuid()) clientId: string,
    @Param('invitationId', uuid()) invitationId: string,
    @Req() req: Request,
  ): Promise<void> {
    return this.access.revokeInvitation(clientId, invitationId, this.client(req));
  }

  @Get('portal-users')
  @RequireFeature('clientPortal')
  @ApiOperation({ summary: 'Portal accounts with access to this client, and pending invitations' })
  @ApiZodResponse(HttpStatus.OK, PortalUsersSchema)
  list(@Param('clientId', uuid()) clientId: string): Promise<PortalUsers> {
    return this.access.list(clientId);
  }

  @Delete('portal-users/:accessId')
  @AllowWhenReadOnly()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Revoke a portal account's access; its sessions end at once" })
  @ApiNoContentResponse({ description: 'Revoked' })
  revoke(
    @Param('clientId', uuid()) clientId: string,
    @Param('accessId', uuid()) accessId: string,
    @Req() req: Request,
  ): Promise<void> {
    return this.access.revokeAccess(clientId, accessId, this.client(req));
  }

  private client(req: Request): ClientInfo {
    return clientFromRequest(req, this.cls.getId());
  }
}
