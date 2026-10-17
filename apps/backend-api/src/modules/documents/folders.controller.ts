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
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CreateFolderSchema, FolderSchema, UpdateFolderSchema } from '@nexlegtiq/shared-contracts';
import type { CreateFolderRequest, Folder, UpdateFolderRequest } from '@nexlegtiq/shared-contracts';
import type { Request } from 'express';
import { ClsService } from 'nestjs-cls';

import { FoldersService } from './folders.service';
import type { RequestContext } from '../../common/context/request-context';
import { ResourceNotFoundException } from '../../common/errors/app.exception';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe';
import { ApiZodBody, ApiZodResponse } from '../../common/openapi/api-zod.decorators';
import { RequireAnyPermission, RequirePermissions } from '../../common/rbac/permissions.decorator';
import { clientFromRequest } from '../auth/client-info';
import type { ClientInfo } from '../auth/client-info';

/** A malformed id is the same 404 as an unknown one (D-019). */
const uuid = new ParseUUIDPipe({ exceptionFactory: () => new ResourceNotFoundException() });

/**
 * Folders of a file (api-conventions.md#documents, MVP-71, D-119). Reading follows the file; organising needs
 * `upload:document`, deleting `delete:document`, and the file must not be archived (BIZ-007).
 */
@ApiTags('documents')
@ApiBearerAuth('JWT')
@Controller('cases/:id/folders')
export class FoldersController {
  constructor(
    private readonly folders: FoldersService,
    private readonly cls: ClsService<RequestContext>,
  ) {}

  @Get()
  @RequireAnyPermission('view:all:cases', 'view:assigned:cases')
  @ApiOperation({ summary: "A file's folders (flat; system folders first)" })
  @ApiZodResponse(HttpStatus.OK, FolderSchema.array())
  list(@Param('id', uuid) fileId: string): Promise<Folder[]> {
    return this.folders.list(fileId);
  }

  @Post()
  @RequirePermissions('upload:document')
  @ApiOperation({ summary: 'Create a folder (409 RES-002 when a sibling has the name)' })
  @ApiZodBody(CreateFolderSchema)
  @ApiZodResponse(HttpStatus.CREATED, FolderSchema)
  create(
    @Param('id', uuid) fileId: string,
    @Body(new ZodValidationPipe(CreateFolderSchema)) body: CreateFolderRequest,
    @Req() req: Request,
  ): Promise<Folder> {
    return this.folders.create(fileId, body, this.client(req));
  }

  @Patch(':folderId')
  @RequirePermissions('upload:document')
  @ApiOperation({ summary: 'Rename or move a folder (422 BIZ-014 for a default folder)' })
  @ApiZodBody(UpdateFolderSchema)
  @ApiZodResponse(HttpStatus.OK, FolderSchema)
  update(
    @Param('id', uuid) fileId: string,
    @Param('folderId', uuid) folderId: string,
    @Body(new ZodValidationPipe(UpdateFolderSchema)) body: UpdateFolderRequest,
    @Req() req: Request,
  ): Promise<Folder> {
    return this.folders.update(fileId, folderId, body, this.client(req));
  }

  @Delete(':folderId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('delete:document')
  @ApiOperation({
    summary: 'Delete an empty folder (422 BIZ-013 when not empty, BIZ-014 for a default folder)',
  })
  async remove(
    @Param('id', uuid) fileId: string,
    @Param('folderId', uuid) folderId: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.folders.remove(fileId, folderId, this.client(req));
  }

  private client(req: Request): ClientInfo {
    return clientFromRequest(req, this.cls.isActive() ? this.cls.getId() : null);
  }
}
