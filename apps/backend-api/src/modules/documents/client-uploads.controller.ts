import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AcceptClientUploadSchema,
  ClientUploadSchema,
  DownloadLinkSchema,
  RejectClientUploadSchema,
} from '@nexlegtiq/shared-contracts';
import type {
  AcceptClientUploadRequest,
  ClientUpload,
  DownloadLink,
  RejectClientUploadRequest,
} from '@nexlegtiq/shared-contracts';
import type { Request } from 'express';
import { ClsService } from 'nestjs-cls';

import { ClientUploadsService } from './client-uploads.service';
import type { RequestContext } from '../../common/context/request-context';
import { ResourceNotFoundException } from '../../common/errors/app.exception';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe';
import { ApiZodBody, ApiZodResponse } from '../../common/openapi/api-zod.decorators';
import { RequireAnyPermission, RequirePermissions } from '../../common/rbac/permissions.decorator';
import { clientFromRequest } from '../auth/client-info';
import type { ClientInfo } from '../auth/client-info';

const uuid = new ParseUUIDPipe({ exceptionFactory: () => new ResourceNotFoundException() });

/** A file's review queue of client uploads (MVP-99, D-187). */
@ApiTags('client-uploads')
@ApiBearerAuth('JWT')
@Controller('cases/:id/client-uploads')
export class CaseClientUploadsController {
  constructor(private readonly uploads: ClientUploadsService) {}

  @Get()
  @RequireAnyPermission('view:all:cases', 'view:assigned:cases')
  @ApiOperation({ summary: "What the file's clients sent through the portal, newest first" })
  @ApiZodResponse(HttpStatus.OK, ClientUploadSchema.array())
  list(@Param('id', uuid) fileId: string): Promise<ClientUpload[]> {
    return this.uploads.list(fileId);
  }
}

/** Reviewing one client upload (D-187): look at it, then accept or reject it once. */
@ApiTags('client-uploads')
@ApiBearerAuth('JWT')
@Controller('client-uploads')
export class ClientUploadsController {
  constructor(
    private readonly uploads: ClientUploadsService,
    private readonly cls: ClsService<RequestContext>,
  ) {}

  @Get(':id/download')
  @RequireAnyPermission('view:all:cases', 'view:assigned:cases')
  @ApiOperation({ summary: 'A 5-minute link to an upload waiting for review (audited)' })
  @ApiZodResponse(HttpStatus.OK, DownloadLinkSchema)
  download(@Param('id', uuid) id: string, @Req() req: Request): Promise<DownloadLink> {
    return this.uploads.download(id, this.client(req));
  }

  @Post(':id/accept')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('upload:document')
  @ApiOperation({
    summary:
      'File the upload as a document (Client Uploads folder by default); 422 BIZ-028 if reviewed',
  })
  @ApiZodBody(AcceptClientUploadSchema)
  @ApiZodResponse(HttpStatus.OK, ClientUploadSchema)
  accept(
    @Param('id', uuid) id: string,
    @Body(new ZodValidationPipe(AcceptClientUploadSchema)) body: AcceptClientUploadRequest,
    @Req() req: Request,
  ): Promise<ClientUpload> {
    return this.uploads.accept(id, body, this.client(req));
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('upload:document')
  @ApiOperation({
    summary: 'Refuse the upload with a reason the client reads; 422 BIZ-028 if reviewed',
  })
  @ApiZodBody(RejectClientUploadSchema)
  @ApiZodResponse(HttpStatus.OK, ClientUploadSchema)
  reject(
    @Param('id', uuid) id: string,
    @Body(new ZodValidationPipe(RejectClientUploadSchema)) body: RejectClientUploadRequest,
    @Req() req: Request,
  ): Promise<ClientUpload> {
    return this.uploads.reject(id, body, this.client(req));
  }

  private client(req: Request): ClientInfo {
    return clientFromRequest(req, this.cls.isActive() ? this.cls.getId() : null);
  }
}
