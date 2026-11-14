import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RetainerDepositSchema, RetainerSchema } from '@nexlegtiq/shared-contracts';
import type { Retainer, RetainerDepositRequest } from '@nexlegtiq/shared-contracts';

import { RetainerService } from './retainer.service';
import { ResourceNotFoundException } from '../../common/errors/app.exception';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe';
import { ApiZodBody, ApiZodResponse } from '../../common/openapi/api-zod.decorators';
import { RequireAnyPermission, RequirePermissions } from '../../common/rbac/permissions.decorator';

const fileId = new ParseUUIDPipe({ exceptionFactory: () => new ResourceNotFoundException() });

/** A file's retainer (MVP-147, D-176): the invoice rights apply — a file whose invoices the caller cannot see is 404. */
@ApiTags('invoices')
@ApiBearerAuth('JWT')
@Controller('cases/:id/retainer')
export class RetainerController {
  constructor(private readonly retainers: RetainerService) {}

  @Get()
  @RequireAnyPermission('view:all:invoices', 'view:assigned:invoices')
  @ApiOperation({ summary: "The file's retainer balance and ledger, newest first" })
  @ApiZodResponse(HttpStatus.OK, RetainerSchema)
  get(@Param('id', fileId) id: string): Promise<Retainer> {
    return this.retainers.get(id);
  }

  @Post('deposit')
  @RequirePermissions('mark:invoice:paid')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Record money the client paid in advance, in the file currency (audited, on the timeline)',
  })
  @ApiZodBody(RetainerDepositSchema)
  @ApiZodResponse(HttpStatus.CREATED, RetainerSchema)
  deposit(
    @Param('id', fileId) id: string,
    @Body(new ZodValidationPipe(RetainerDepositSchema)) body: RetainerDepositRequest,
  ): Promise<Retainer> {
    return this.retainers.deposit(id, body);
  }
}
