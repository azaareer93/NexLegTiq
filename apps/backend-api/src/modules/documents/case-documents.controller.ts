import { Controller, Get, HttpStatus, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { DocumentQuerySchema, DocumentSchema } from '@nexlegtiq/shared-contracts';
import type { Document, DocumentQuery } from '@nexlegtiq/shared-contracts';

import { DocumentRecordsService } from './document-records.service';
import { ResourceNotFoundException } from '../../common/errors/app.exception';
import type { PaginatedResult } from '../../common/http/paginated-result';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe';
import { ApiZodQuery, ApiZodResponse } from '../../common/openapi/api-zod.decorators';
import { RequireAnyPermission } from '../../common/rbac/permissions.decorator';

/** A malformed id is the same 404 as an unknown one (D-019). */
const uuid = new ParseUUIDPipe({ exceptionFactory: () => new ResourceNotFoundException() });

/** The documents of a file (api-conventions.md#documents, MVP-74, D-128). */
@ApiTags('documents')
@ApiBearerAuth('JWT')
@Controller('cases/:id/documents')
export class CaseDocumentsController {
  constructor(private readonly records: DocumentRecordsService) {}

  @Get()
  @RequireAnyPermission('view:all:cases', 'view:assigned:cases')
  @ApiOperation({
    summary: "A file's documents the caller may see (folder, type, status, search; newest first)",
  })
  @ApiZodQuery(DocumentQuerySchema)
  @ApiZodResponse(HttpStatus.OK, DocumentSchema, { paginated: true })
  list(
    @Param('id', uuid) fileId: string,
    @Query(new ZodValidationPipe(DocumentQuerySchema)) query: DocumentQuery,
  ): Promise<PaginatedResult<Document>> {
    return this.records.list(fileId, query);
  }
}
