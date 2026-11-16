import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  DownloadLinkSchema,
  PortalDocumentSchema,
  PortalFileDetailSchema,
  PortalFileSchema,
  PortalUploadSchema,
} from '@nexlegtiq/shared-contracts';
import type {
  DownloadLink,
  PortalDocument,
  PortalFile,
  PortalFileDetail,
  PortalUpload,
} from '@nexlegtiq/shared-contracts';
import type { Request } from 'express';
import { ClsService } from 'nestjs-cls';

import { PortalService } from './portal.service';
import { Public } from '../../common/auth/public.decorator';
import type { RequestContext } from '../../common/context/request-context';
import { ResourceNotFoundException } from '../../common/errors/app.exception';
import { ApiZodResponse } from '../../common/openapi/api-zod.decorators';
import { clientFromRequest } from '../auth/client-info';
import { PortalAuthGuard, PortalRealmGuard } from '../portal-auth/portal-guards';

type PortalRequest = Request & { clientUserId?: string };
const uuid = new ParseUUIDPipe({ exceptionFactory: () => new ResourceNotFoundException() });

/**
 * The client's own data on the portal (MVP-98, D-186). `@Public()` takes the routes out of the office JWT guard; the
 * portal guards answer 404 while the realm is off and check the portal session and grants on every request.
 */
@ApiTags('portal')
@ApiBearerAuth('JWT')
@Public()
@UseGuards(PortalRealmGuard, PortalAuthGuard)
@Controller('portal')
export class PortalController {
  constructor(
    private readonly portal: PortalService,
    private readonly cls: ClsService<RequestContext>,
  ) {}

  @Get('files')
  @ApiOperation({ summary: "The client's files: number, title, status, lawyer, next hearing" })
  @ApiZodResponse(200, PortalFileSchema.array())
  files(@Req() req: PortalRequest): Promise<PortalFile[]> {
    return this.portal.files(this.account(req));
  }

  @Get('files/:id')
  @ApiOperation({ summary: 'A file with its public timeline (kinds and times only)' })
  @ApiZodResponse(200, PortalFileDetailSchema)
  file(@Param('id', uuid) id: string, @Req() req: PortalRequest): Promise<PortalFileDetail> {
    return this.portal.file(this.account(req), id);
  }

  @Get('files/:id/documents')
  @ApiOperation({ summary: 'The documents the office shared on the file' })
  @ApiZodResponse(200, PortalDocumentSchema.array())
  documents(@Param('id', uuid) id: string, @Req() req: PortalRequest): Promise<PortalDocument[]> {
    return this.portal.documents(this.account(req), id);
  }

  @Post('files/:id/uploads')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary:
      'Send a document to the office (multipart `file`): scanned, then reviewed by a lawyer (D-187)',
  })
  @ApiZodResponse(HttpStatus.ACCEPTED, PortalUploadSchema)
  upload(@Param('id', uuid) id: string, @Req() req: PortalRequest): Promise<PortalUpload> {
    return this.portal.upload(this.account(req), id, req, this.client(req));
  }

  @Get('files/:id/uploads')
  @ApiOperation({ summary: 'What the client sent on the file, with the review status' })
  @ApiZodResponse(200, PortalUploadSchema.array())
  uploads(@Param('id', uuid) id: string, @Req() req: PortalRequest): Promise<PortalUpload[]> {
    return this.portal.uploads(this.account(req), id);
  }

  @Get('documents/:id/download')
  @ApiOperation({ summary: 'A 5-minute download link to a shared document (audited)' })
  @ApiZodResponse(200, DownloadLinkSchema)
  download(@Param('id', uuid) id: string, @Req() req: PortalRequest): Promise<DownloadLink> {
    return this.portal.download(this.account(req), id, this.client(req));
  }

  private client(req: Request) {
    return clientFromRequest(req, this.cls.isActive() ? this.cls.getId() : null);
  }

  private account(req: PortalRequest): string {
    // PortalAuthGuard always sets it; its absence is a wiring error (500), never a lookup of an empty id.
    if (!req.clientUserId) throw new Error('PortalAuthGuard did not run');
    return req.clientUserId;
  }
}
