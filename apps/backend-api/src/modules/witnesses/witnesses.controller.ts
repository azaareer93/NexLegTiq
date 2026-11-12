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
} from '@nestjs/common';
import { ApiBearerAuth, ApiNoContentResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  CreateWitnessSchema,
  CreateWitnessStatementSchema,
  UpdateWitnessSchema,
  UpdateWitnessStatementSchema,
  WitnessSchema,
  WitnessStatementSchema,
} from '@nexlegtiq/shared-contracts';
import type {
  CreateWitnessRequest,
  CreateWitnessStatementRequest,
  UpdateWitnessRequest,
  UpdateWitnessStatementRequest,
  Witness,
  WitnessStatement,
} from '@nexlegtiq/shared-contracts';

import { WitnessesService } from './witnesses.service';
import { ResourceNotFoundException } from '../../common/errors/app.exception';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe';
import { ApiZodBody, ApiZodResponse } from '../../common/openapi/api-zod.decorators';
import { RequireAnyPermission } from '../../common/rbac/permissions.decorator';

const uuid = new ParseUUIDPipe({ exceptionFactory: () => new ResourceNotFoundException() });
const READ = ['view:all:cases', 'view:assigned:cases'] as const;
const EDIT = ['edit:any:case', 'edit:assigned:case'] as const;

/** A file's witnesses (MVP-143, D-163). Never shown on the client portal. */
@ApiTags('cases')
@ApiBearerAuth('JWT')
@Controller('cases/:id/witnesses')
export class WitnessesController {
  constructor(private readonly witnesses: WitnessesService) {}

  @Get()
  @RequireAnyPermission(...READ)
  @ApiOperation({ summary: "A file's witnesses and experts, by name" })
  @ApiZodResponse(HttpStatus.OK, WitnessSchema.array())
  list(@Param('id', uuid) fileId: string): Promise<Witness[]> {
    return this.witnesses.list(fileId);
  }

  @Post()
  @RequireAnyPermission(...EDIT)
  @ApiZodBody(CreateWitnessSchema)
  @ApiZodResponse(HttpStatus.CREATED, WitnessSchema)
  create(
    @Param('id', uuid) fileId: string,
    @Body(new ZodValidationPipe(CreateWitnessSchema)) body: CreateWitnessRequest,
  ): Promise<Witness> {
    return this.witnesses.create(fileId, body);
  }

  @Patch(':witnessId')
  @RequireAnyPermission(...EDIT)
  @ApiZodBody(UpdateWitnessSchema)
  @ApiZodResponse(HttpStatus.OK, WitnessSchema)
  update(
    @Param('id', uuid) fileId: string,
    @Param('witnessId', uuid) witnessId: string,
    @Body(new ZodValidationPipe(UpdateWitnessSchema)) body: UpdateWitnessRequest,
  ): Promise<Witness> {
    return this.witnesses.update(fileId, witnessId, body);
  }

  @Delete(':witnessId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireAnyPermission(...EDIT)
  @ApiOperation({ summary: 'Delete a witness and their statements' })
  @ApiNoContentResponse()
  remove(
    @Param('id', uuid) fileId: string,
    @Param('witnessId', uuid) witnessId: string,
  ): Promise<void> {
    return this.witnesses.remove(fileId, witnessId);
  }
}

/** A witness's recorded statements (MVP-143, D-163). */
@ApiTags('cases')
@ApiBearerAuth('JWT')
@Controller('witnesses/:id/statements')
export class WitnessStatementsController {
  constructor(private readonly witnesses: WitnessesService) {}

  @Get()
  @RequireAnyPermission(...READ)
  @ApiOperation({ summary: "A witness's statements, newest first" })
  @ApiZodResponse(HttpStatus.OK, WitnessStatementSchema.array())
  list(@Param('id', uuid) witnessId: string): Promise<WitnessStatement[]> {
    return this.witnesses.statements(witnessId);
  }

  @Post()
  @RequireAnyPermission(...EDIT)
  @ApiZodBody(CreateWitnessStatementSchema)
  @ApiZodResponse(HttpStatus.CREATED, WitnessStatementSchema)
  create(
    @Param('id', uuid) witnessId: string,
    @Body(new ZodValidationPipe(CreateWitnessStatementSchema)) body: CreateWitnessStatementRequest,
  ): Promise<WitnessStatement> {
    return this.witnesses.addStatement(witnessId, body);
  }

  @Patch(':statementId')
  @RequireAnyPermission(...EDIT)
  @ApiZodBody(UpdateWitnessStatementSchema)
  @ApiZodResponse(HttpStatus.OK, WitnessStatementSchema)
  update(
    @Param('id', uuid) witnessId: string,
    @Param('statementId', uuid) statementId: string,
    @Body(new ZodValidationPipe(UpdateWitnessStatementSchema)) body: UpdateWitnessStatementRequest,
  ): Promise<WitnessStatement> {
    return this.witnesses.updateStatement(witnessId, statementId, body);
  }

  @Delete(':statementId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireAnyPermission(...EDIT)
  @ApiNoContentResponse()
  remove(
    @Param('id', uuid) witnessId: string,
    @Param('statementId', uuid) statementId: string,
  ): Promise<void> {
    return this.witnesses.removeStatement(witnessId, statementId);
  }
}
