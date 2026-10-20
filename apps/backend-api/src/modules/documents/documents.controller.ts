import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiConsumes, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  DocumentSchema,
  DocumentTextQuerySchema,
  DocumentTextSchema,
  DocumentUploadSchema,
  DocumentVersionSchema,
  DownloadLinkSchema,
  DownloadQuerySchema,
  UpdateDocumentSchema,
} from '@nexlegtiq/shared-contracts';
import type {
  Document,
  DocumentText,
  DocumentUpload,
  DocumentVersion,
  DownloadLink,
  UpdateDocumentRequest,
} from '@nexlegtiq/shared-contracts';
import type { Request } from 'express';
import { ClsService } from 'nestjs-cls';

import { DocumentRecordsService } from './document-records.service';
import { DocumentsService } from './documents.service';
import type { RequestContext } from '../../common/context/request-context';
import { ResourceNotFoundException } from '../../common/errors/app.exception';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe';
import { ApiZodBody, ApiZodQuery, ApiZodResponse } from '../../common/openapi/api-zod.decorators';
import { RequireAnyPermission, RequirePermissions } from '../../common/rbac/permissions.decorator';
import { clientFromRequest } from '../auth/client-info';
import type { ClientInfo } from '../auth/client-info';

/** A malformed id is the same 404 as an unknown one (D-019). */
const uuid = new ParseUUIDPipe({ exceptionFactory: () => new ResourceNotFoundException() });

/** Uploads: 20 a minute (api-conventions.md), per IP like every limit (D-082: they run before authentication). */
const UPLOADS = { default: { limit: 20, ttl: 60_000 } };

/**
 * Document uploads and versions (api-conventions.md#documents, MVP-72, D-126). Multipart bodies are streamed by the
 * service (no Nest body parsing): text fields first, then `file`. Both uploads answer 202 — the document is scanned for
 * malware, then processed, in the background.
 */
@ApiTags('documents')
@ApiBearerAuth('JWT')
@Controller('documents')
export class DocumentsController {
  constructor(
    private readonly documents: DocumentsService,
    private readonly records: DocumentRecordsService,
    private readonly cls: ClsService<RequestContext>,
  ) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle(UPLOADS)
  @RequirePermissions('upload:document')
  @ApiConsumes('multipart/form-data')
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiOperation({
    summary:
      'Upload a document: fields fileId, documentType, folderId?, sessionId?, isConfidential? before the file part ' +
      '(≤ 50 MB: 413 VAL-006; type sniffed from the bytes: 415 VAL-005; quota: 403 AUTH-103)',
  })
  @ApiZodResponse(HttpStatus.ACCEPTED, DocumentUploadSchema)
  upload(
    @Req() req: Request,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<DocumentUpload> {
    return this.documents.upload(req, idempotencyKey, this.client(req));
  }

  @Post(':id/versions')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle(UPLOADS)
  @RequirePermissions('upload:document')
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload a new version: field changeNote? before the file part' })
  @ApiZodResponse(HttpStatus.ACCEPTED, DocumentUploadSchema)
  addVersion(@Param('id', uuid) id: string, @Req() req: Request): Promise<DocumentUpload> {
    return this.documents.addVersion(id, req, this.client(req));
  }

  @Get(':id/versions')
  @RequireAnyPermission('view:all:cases', 'view:assigned:cases')
  @ApiOperation({ summary: "A document's versions, newest first" })
  @ApiZodResponse(HttpStatus.OK, DocumentVersionSchema.array())
  versions(@Param('id', uuid) id: string): Promise<DocumentVersion[]> {
    return this.documents.versions(id);
  }

  @Get(':id')
  @RequireAnyPermission('view:all:cases', 'view:assigned:cases')
  @ApiOperation({ summary: 'A document (404 when the caller may not see it)' })
  @ApiZodResponse(HttpStatus.OK, DocumentSchema)
  get(@Param('id', uuid) id: string): Promise<Document> {
    return this.records.get(id);
  }

  @Patch(':id')
  @RequirePermissions('upload:document')
  @ApiOperation({ summary: 'Rename, retype, move or (un)mark confidential' })
  @ApiZodBody(UpdateDocumentSchema)
  @ApiZodResponse(HttpStatus.OK, DocumentSchema)
  update(
    @Param('id', uuid) id: string,
    @Body(new ZodValidationPipe(UpdateDocumentSchema)) body: UpdateDocumentRequest,
    @Req() req: Request,
  ): Promise<Document> {
    return this.records.update(id, body, this.client(req));
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('delete:document')
  @ApiOperation({
    summary: 'Soft-delete a document (its stored objects stay until the retention purge)',
  })
  async remove(@Param('id', uuid) id: string, @Req() req: Request): Promise<void> {
    await this.records.remove(id, this.client(req));
  }

  @Get(':id/download')
  @RequireAnyPermission('view:all:cases', 'view:assigned:cases')
  @ApiOperation({
    summary:
      'A 5-minute download link (audited); 422 STO-004 when quarantined, BIZ-015 while not scanned clean',
  })
  @ApiZodQuery(DownloadQuerySchema)
  @ApiZodResponse(HttpStatus.OK, DownloadLinkSchema)
  download(
    @Param('id', uuid) id: string,
    @Query(new ZodValidationPipe(DownloadQuerySchema)) query: { version?: number },
    @Req() req: Request,
  ): Promise<DownloadLink> {
    return this.records.download(id, query.version, this.client(req));
  }

  @Get(':id/text')
  @RequireAnyPermission('view:all:cases', 'view:assigned:cases')
  @ApiOperation({ summary: "The current version's extracted text, 20,000 characters a page" })
  @ApiZodQuery(DocumentTextQuerySchema)
  @ApiZodResponse(HttpStatus.OK, DocumentTextSchema)
  text(
    @Param('id', uuid) id: string,
    @Query(new ZodValidationPipe(DocumentTextQuerySchema)) query: { page: number },
  ): Promise<DocumentText> {
    return this.records.text(id, query.page);
  }

  private client(req: Request): ClientInfo {
    return clientFromRequest(req, this.cls.isActive() ? this.cls.getId() : null);
  }
}
