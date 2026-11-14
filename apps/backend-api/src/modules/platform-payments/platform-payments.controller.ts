import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  AdminPaymentSchema,
  PaymentReceiptQuerySchema,
  PaymentReceiptSchema,
  RecordPaymentSchema,
  VoidPaymentSchema,
} from '@nexlegtiq/shared-contracts';
import type {
  AdminPayment,
  PaymentReceiptQuery,
  PaymentReceipt,
  RecordPaymentRequest,
  VoidPaymentRequest,
} from '@nexlegtiq/shared-contracts';
import type { Request, Response } from 'express';
import { ClsService } from 'nestjs-cls';

import { PlatformPaymentsService } from './platform-payments.service';
import { Public } from '../../common/auth/public.decorator';
import type { RequestContext } from '../../common/context/request-context';
import { ResourceNotFoundException } from '../../common/errors/app.exception';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe';
import { ApiZodBody, ApiZodQuery, ApiZodResponse } from '../../common/openapi/api-zod.decorators';
import { clientFromRequest } from '../auth/client-info';
import type { ClientInfo } from '../auth/client-info';
import { AdminAuthGuard, AdminRealmGuard } from '../platform-auth/admin-guards';

const uuid = () => new ParseUUIDPipe({ exceptionFactory: () => new ResourceNotFoundException() });
const MINUTE_MS = 60_000;
type AdminRequest = Request & { platformAdminId?: string };

/** Platform realm (D-145): an office's manual payments and their receipts (MVP-170, D-174). */
@ApiTags('admin')
@ApiBearerAuth('JWT')
@Public()
@UseGuards(AdminRealmGuard, AdminAuthGuard)
@Controller('admin')
export class PlatformPaymentsController {
  constructor(
    private readonly payments: PlatformPaymentsService,
    private readonly cls: ClsService<RequestContext>,
  ) {}

  @Get('offices/:id/payments')
  @ApiOperation({ summary: "An office's payments, newest first" })
  @ApiZodResponse(HttpStatus.OK, AdminPaymentSchema.array())
  list(@Param('id', uuid()) id: string): Promise<AdminPayment[]> {
    return this.payments.list(id);
  }

  @Post('offices/:id/payments')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { limit: 30, ttl: MINUTE_MS } })
  @ApiOperation({
    summary:
      'Record a cash/bank payment with a numbered receipt, emailed to the office; the subscription is unchanged (audited)',
  })
  @ApiZodBody(RecordPaymentSchema)
  @ApiZodResponse(HttpStatus.CREATED, AdminPaymentSchema)
  record(
    @Param('id', uuid()) id: string,
    @Body(new ZodValidationPipe(RecordPaymentSchema)) body: RecordPaymentRequest,
    @Req() req: AdminRequest,
  ): Promise<AdminPayment> {
    return this.payments.record(id, body, this.adminId(req), this.client(req));
  }

  @Post('payments/:id/void')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: MINUTE_MS } })
  @ApiOperation({ summary: 'Void a mistaken payment; it keeps its receipt number (audited)' })
  @ApiZodBody(VoidPaymentSchema)
  @ApiZodResponse(HttpStatus.OK, AdminPaymentSchema)
  void(
    @Param('id', uuid()) id: string,
    @Body(new ZodValidationPipe(VoidPaymentSchema)) body: VoidPaymentRequest,
    @Req() req: AdminRequest,
  ): Promise<AdminPayment> {
    return this.payments.void(id, body.reason.trim(), this.adminId(req), this.client(req));
  }

  @Get('payments/:id/receipt')
  @Throttle({ default: { limit: 30, ttl: MINUTE_MS } })
  @ApiOperation({ summary: 'A short-lived link to the receipt PDF (200), or 202 while it renders' })
  @ApiZodQuery(PaymentReceiptQuerySchema)
  @ApiZodResponse(HttpStatus.OK, PaymentReceiptSchema)
  async receipt(
    @Param('id', uuid()) id: string,
    @Query(new ZodValidationPipe(PaymentReceiptQuerySchema)) query: PaymentReceiptQuery,
    @Req() req: AdminRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PaymentReceipt> {
    const result = await this.payments.receipt(
      id,
      query.language,
      this.adminId(req),
      this.client(req),
    );
    if (result.status === 'RENDERING') res.status(HttpStatus.ACCEPTED);
    return result;
  }

  private adminId(req: AdminRequest): string {
    // AdminAuthGuard always sets it; its absence is a wiring error (500).
    if (!req.platformAdminId) throw new Error('AdminAuthGuard did not run');
    return req.platformAdminId;
  }

  private client(req: Request): ClientInfo {
    return clientFromRequest(req, this.cls.isActive() ? this.cls.getId() : null);
  }
}
