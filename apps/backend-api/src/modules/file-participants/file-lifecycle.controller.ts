import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiNoContentResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  CloseCaseSchema,
  FileTeamMemberSchema,
  ReassignCaseSchema,
} from '@nexlegtiq/shared-contracts';
import type {
  CloseCaseRequest,
  FileTeamMember,
  ReassignCaseRequest,
} from '@nexlegtiq/shared-contracts';
import type { Request } from 'express';
import { ClsService } from 'nestjs-cls';

import { FileLifecycleService } from './file-lifecycle.service';
import type { RequestContext } from '../../common/context/request-context';
import { ResourceNotFoundException } from '../../common/errors/app.exception';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe';
import { ApiZodBody, ApiZodResponse } from '../../common/openapi/api-zod.decorators';
import {
  PermissionConditionsCheckedByService,
  RequirePermissions,
} from '../../common/rbac/permissions.decorator';
import { clientFromRequest } from '../auth/client-info';

const uuid = new ParseUUIDPipe({ exceptionFactory: () => new ResourceNotFoundException() });

/** A file's lifecycle (MVP-64, D-153): close, reopen, archive, reassign. Each answers once the change is committed. */
@ApiTags('cases')
@ApiBearerAuth('JWT')
@Controller('cases/:id')
export class FileLifecycleController {
  constructor(
    private readonly lifecycle: FileLifecycleService,
    private readonly cls: ClsService<RequestContext>,
  ) {}

  private client(req: Request) {
    return clientFromRequest(req, this.cls.isActive() ? this.cls.getId() : null);
  }

  @Post('close')
  @HttpCode(HttpStatus.NO_CONTENT)
  // A LAWYER closes only as the file's responsible lawyer: checked by the service (D-081).
  @RequirePermissions('close:case')
  @PermissionConditionsCheckedByService()
  @ApiOperation({
    summary: 'Close a file (open tasks → 422 BIZ-003 unless force with forceReason)',
  })
  @ApiZodBody(CloseCaseSchema)
  @ApiNoContentResponse()
  close(
    @Param('id', uuid) fileId: string,
    @Body(new ZodValidationPipe(CloseCaseSchema)) body: CloseCaseRequest,
    @Req() req: Request,
  ): Promise<void> {
    return this.lifecycle.close(fileId, body, this.client(req));
  }

  @Post('reopen')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('reopen:case')
  @PermissionConditionsCheckedByService()
  @ApiOperation({ summary: 'Reopen a closed file' })
  @ApiNoContentResponse()
  reopen(@Param('id', uuid) fileId: string, @Req() req: Request): Promise<void> {
    return this.lifecycle.reopen(fileId, this.client(req));
  }

  @Post('archive')
  @HttpCode(HttpStatus.NO_CONTENT)
  // The office manager and senior lawyers only: checked by the service on the role.
  @RequirePermissions('close:case')
  @PermissionConditionsCheckedByService()
  @ApiOperation({ summary: 'Archive a closed file (read-only for everyone)' })
  @ApiNoContentResponse()
  archive(@Param('id', uuid) fileId: string, @Req() req: Request): Promise<void> {
    return this.lifecycle.archive(fileId, this.client(req));
  }

  @Post('reassign')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('edit:any:case')
  @ApiOperation({ summary: 'Name a new responsible lawyer (both lawyers are notified)' })
  @ApiZodBody(ReassignCaseSchema)
  @ApiZodResponse(HttpStatus.OK, FileTeamMemberSchema.array())
  reassign(
    @Param('id', uuid) fileId: string,
    @Body(new ZodValidationPipe(ReassignCaseSchema)) body: ReassignCaseRequest,
    @Req() req: Request,
  ): Promise<FileTeamMember[]> {
    return this.lifecycle.reassign(fileId, body, this.client(req));
  }
}
