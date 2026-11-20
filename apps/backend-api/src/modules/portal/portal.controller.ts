import {
  Controller,
  Get,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  DownloadLinkSchema,
  PortalDocumentSchema,
  PortalFileDetailSchema,
  PortalFileSchema,
  PortalInvoicePdfSchema,
  PortalInvoiceSchema,
} from '@nexlegtiq/shared-contracts';
import type {
  DownloadLink,
  PortalDocument,
  PortalFile,
  PortalFileDetail,
  PortalInvoice,
  PortalInvoicePdf,
} from '@nexlegtiq/shared-contracts';
import type { Request, Response } from 'express';
import { ClsService } from 'nestjs-cls';

import { PortalInvoicesService } from './portal-invoices.service';
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
    private readonly invoiceList: PortalInvoicesService,
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

  @Get('invoices')
  @ApiOperation({
    summary: 'The invoices the offices shared with the client (sent, overdue or paid)',
  })
  @ApiZodResponse(200, PortalInvoiceSchema.array())
  invoices(@Req() req: PortalRequest): Promise<PortalInvoice[]> {
    return this.invoiceList.list(this.account(req));
  }

  @Get('invoices/:id/pdf')
  // Each ask may queue a Chromium print on the office's report queue (D-171).
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary: 'A shared invoice PDF: 200 with a 5-minute link, or 202 while it renders (ask again)',
  })
  @ApiZodResponse(200, PortalInvoicePdfSchema)
  @ApiZodResponse(202, PortalInvoicePdfSchema)
  async invoicePdf(
    @Param('id', uuid) id: string,
    @Req() req: PortalRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PortalInvoicePdf> {
    const answer = await this.invoiceList.pdf(this.account(req), id, this.client(req));
    res.status(answer.status === 'READY' ? HttpStatus.OK : HttpStatus.ACCEPTED);
    return answer;
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
