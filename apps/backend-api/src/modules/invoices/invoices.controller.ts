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
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiNoContentResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  CreateInvoiceSchema,
  InvoiceListItemSchema,
  InvoicePdfQuerySchema,
  InvoicePdfSchema,
  InvoiceQuerySchema,
  InvoiceSchema,
  InvoiceSummaryQuerySchema,
  InvoiceSummarySchema,
  MarkInvoicePaidSchema,
  SendInvoiceSchema,
  UpdateInvoiceSchema,
} from '@nexlegtiq/shared-contracts';
import type {
  CreateInvoiceBody,
  Invoice,
  InvoiceListItem,
  InvoicePdf,
  InvoicePdfQuery,
  InvoiceQuery,
  InvoiceSummary,
  InvoiceSummaryQuery,
  MarkInvoicePaidRequest,
  SendInvoiceRequest,
  UpdateInvoiceRequest,
} from '@nexlegtiq/shared-contracts';
import type { Response } from 'express';

import { InvoiceLifecycle } from './invoice-lifecycle.service';
import { InvoicesService } from './invoices.service';
import { InvoicePdfService } from './pdf/invoice-pdf.service';
import { ResourceNotFoundException } from '../../common/errors/app.exception';
import type { PaginatedResult } from '../../common/http/paginated-result';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe';
import { ApiZodBody, ApiZodQuery, ApiZodResponse } from '../../common/openapi/api-zod.decorators';
import { RequireAnyPermission, RequirePermissions } from '../../common/rbac/permissions.decorator';

const invoiceId = new ParseUUIDPipe({ exceptionFactory: () => new ResourceNotFoundException() });

/** Invoices (api-conventions.md#billing, MVP-91, D-162). */
@ApiTags('invoices')
@ApiBearerAuth('JWT')
@Controller('invoices')
export class InvoicesController {
  constructor(
    private readonly invoices: InvoicesService,
    private readonly lifecycle: InvoiceLifecycle,
    private readonly pdfs: InvoicePdfService,
  ) {}

  @Get()
  @RequireAnyPermission('view:all:invoices', 'view:assigned:invoices')
  @ApiOperation({ summary: 'Invoices the caller may see (all, or those of assigned files)' })
  @ApiZodQuery(InvoiceQuerySchema)
  @ApiZodResponse(HttpStatus.OK, InvoiceListItemSchema, { paginated: true })
  list(
    @Query(new ZodValidationPipe(InvoiceQuerySchema)) query: InvoiceQuery,
  ): Promise<PaginatedResult<InvoiceListItem>> {
    return this.invoices.list(query);
  }

  // Declared before `:id`, which would otherwise take "summary" as an id.
  @Get('summary')
  @RequireAnyPermission('view:all:invoices', 'view:assigned:invoices')
  @ApiOperation({
    summary: "A client's billed and outstanding totals per currency (visible invoices)",
  })
  @ApiZodQuery(InvoiceSummaryQuerySchema)
  @ApiZodResponse(HttpStatus.OK, InvoiceSummarySchema)
  summary(
    @Query(new ZodValidationPipe(InvoiceSummaryQuerySchema)) query: InvoiceSummaryQuery,
  ): Promise<InvoiceSummary> {
    return this.invoices.summary(query.clientId);
  }

  @Post()
  @RequirePermissions('generate:invoice')
  @ApiOperation({ summary: "Draft an invoice from the client's unbilled billable time" })
  @ApiZodBody(CreateInvoiceSchema)
  @ApiZodResponse(HttpStatus.CREATED, InvoiceSchema)
  create(
    @Body(new ZodValidationPipe(CreateInvoiceSchema)) body: CreateInvoiceBody,
  ): Promise<Invoice> {
    return this.invoices.create(body);
  }

  @Get(':id')
  @RequireAnyPermission('view:all:invoices', 'view:assigned:invoices')
  @ApiZodResponse(HttpStatus.OK, InvoiceSchema)
  get(@Param('id', invoiceId) id: string): Promise<Invoice> {
    return this.invoices.get(id);
  }

  @Patch(':id')
  @RequirePermissions('generate:invoice')
  @ApiOperation({ summary: 'Edit a draft (anything else is 422 BIZ-006)' })
  @ApiZodBody(UpdateInvoiceSchema)
  @ApiZodResponse(HttpStatus.OK, InvoiceSchema)
  update(
    @Param('id', invoiceId) id: string,
    @Body(new ZodValidationPipe(UpdateInvoiceSchema)) body: UpdateInvoiceRequest,
  ): Promise<Invoice> {
    return this.lifecycle.update(id, body);
  }

  @Delete(':id')
  @RequirePermissions('generate:invoice')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a draft and free its time entries' })
  @ApiNoContentResponse()
  remove(@Param('id', invoiceId) id: string): Promise<void> {
    return this.lifecycle.remove(id);
  }

  @Post(':id/send')
  @RequirePermissions('generate:invoice')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Send a draft: assigns its number, issue and due dates, renders its PDF and, with emailClient, emails it to the client (no address → 400 validation.noClientEmail)',
  })
  @ApiZodBody(SendInvoiceSchema, { required: false })
  @ApiZodResponse(HttpStatus.OK, InvoiceSchema)
  send(
    @Param('id', invoiceId) id: string,
    @Body(new ZodValidationPipe(SendInvoiceSchema)) body: SendInvoiceRequest,
  ): Promise<Invoice> {
    return this.lifecycle.send(id, body);
  }

  @Get(':id/pdf')
  @RequireAnyPermission('view:all:invoices', 'view:assigned:invoices')
  // Each ask may queue a Chromium print on the shared report queue (D-171).
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary:
      'The invoice PDF: 200 with a 5-minute link when it shows the invoice as it is now, else 202 while the worker renders it (ask again)',
  })
  @ApiZodQuery(InvoicePdfQuerySchema)
  @ApiZodResponse(200, InvoicePdfSchema)
  @ApiZodResponse(202, InvoicePdfSchema)
  async pdf(
    @Param('id', invoiceId) id: string,
    @Query(new ZodValidationPipe(InvoicePdfQuerySchema)) query: InvoicePdfQuery,
    @Res({ passthrough: true }) res: Response,
  ): Promise<InvoicePdf> {
    const answer = await this.pdfs.link(id, query.language);
    res.status(answer.status === 'READY' ? HttpStatus.OK : HttpStatus.ACCEPTED);
    return answer;
  }

  @Post(':id/mark-paid')
  @RequirePermissions('mark:invoice:paid')
  @HttpCode(HttpStatus.OK)
  @ApiZodBody(MarkInvoicePaidSchema)
  @ApiZodResponse(HttpStatus.OK, InvoiceSchema)
  markPaid(
    @Param('id', invoiceId) id: string,
    @Body(new ZodValidationPipe(MarkInvoicePaidSchema)) body: MarkInvoicePaidRequest,
  ): Promise<Invoice> {
    return this.lifecycle.markPaid(id, body);
  }

  @Post(':id/void')
  @RequirePermissions('generate:invoice')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Void a sent or overdue invoice; its time entries become billable again',
  })
  @ApiZodResponse(HttpStatus.OK, InvoiceSchema)
  void(@Param('id', invoiceId) id: string): Promise<Invoice> {
    return this.lifecycle.void(id);
  }
}
