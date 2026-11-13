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
import { CreateNoteSchema, NoteSchema, UpdateNoteSchema } from '@nexlegtiq/shared-contracts';
import type { CreateNoteRequest, Note, UpdateNoteRequest } from '@nexlegtiq/shared-contracts';

import { NotesService } from './notes.service';
import { ResourceNotFoundException } from '../../common/errors/app.exception';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe';
import { ApiZodBody, ApiZodResponse } from '../../common/openapi/api-zod.decorators';
import { RequireAnyPermission, RequirePermissions } from '../../common/rbac/permissions.decorator';

const uuid = new ParseUUIDPipe({ exceptionFactory: () => new ResourceNotFoundException() });
const EDIT = ['edit:any:case', 'edit:assigned:case'] as const;

/** A file's internal notes (api-conventions.md#cases, MVP-65, D-154). Never shown on the client portal. */
@ApiTags('cases')
@ApiBearerAuth('JWT')
@Controller('cases/:id/notes')
export class NotesController {
  constructor(private readonly notes: NotesService) {}

  @Get()
  @RequireAnyPermission('view:all:cases', 'view:assigned:cases')
  @ApiOperation({
    summary: "A file's notes, pinned first (confidential ones for OM and the file's people)",
  })
  @ApiZodResponse(HttpStatus.OK, NoteSchema.array())
  list(@Param('id', uuid) fileId: string): Promise<Note[]> {
    return this.notes.list({ fileId });
  }

  @Post()
  @RequireAnyPermission(...EDIT)
  @ApiZodBody(CreateNoteSchema)
  @ApiZodResponse(HttpStatus.CREATED, NoteSchema)
  create(
    @Param('id', uuid) fileId: string,
    @Body(new ZodValidationPipe(CreateNoteSchema)) body: CreateNoteRequest,
  ): Promise<Note> {
    return this.notes.create({ fileId }, body);
  }

  @Patch(':noteId')
  @RequireAnyPermission(...EDIT)
  @ApiOperation({ summary: 'Change a note (its author, or OM/SL)' })
  @ApiZodBody(UpdateNoteSchema)
  @ApiZodResponse(HttpStatus.OK, NoteSchema)
  update(
    @Param('id', uuid) fileId: string,
    @Param('noteId', uuid) noteId: string,
    @Body(new ZodValidationPipe(UpdateNoteSchema)) body: UpdateNoteRequest,
  ): Promise<Note> {
    return this.notes.update({ fileId }, noteId, body);
  }

  @Delete(':noteId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireAnyPermission(...EDIT)
  @ApiNoContentResponse()
  remove(@Param('id', uuid) fileId: string, @Param('noteId', uuid) noteId: string): Promise<void> {
    return this.notes.remove({ fileId }, noteId);
  }
}

/**
 * A client's internal notes (MVP-55, D-168), on the client profile — a client route, so `manage:clients` (D-121).
 * Confidential ones are read by the office manager and their author only. Never shown on the client portal.
 */
@ApiTags('clients')
@ApiBearerAuth('JWT')
@Controller('clients/:id/notes')
@RequirePermissions('manage:clients')
export class ClientNotesController {
  constructor(private readonly notes: NotesService) {}

  @Get()
  @ApiOperation({
    summary: "A client's notes, pinned first (confidential ones for OM and their author)",
  })
  @ApiZodResponse(HttpStatus.OK, NoteSchema.array())
  list(@Param('id', uuid) clientId: string): Promise<Note[]> {
    return this.notes.list({ clientId });
  }

  @Post()
  @ApiZodBody(CreateNoteSchema)
  @ApiZodResponse(HttpStatus.CREATED, NoteSchema)
  create(
    @Param('id', uuid) clientId: string,
    @Body(new ZodValidationPipe(CreateNoteSchema)) body: CreateNoteRequest,
  ): Promise<Note> {
    return this.notes.create({ clientId }, body);
  }

  @Patch(':noteId')
  @ApiOperation({ summary: 'Change a client note (its author, or OM/SL)' })
  @ApiZodBody(UpdateNoteSchema)
  @ApiZodResponse(HttpStatus.OK, NoteSchema)
  update(
    @Param('id', uuid) clientId: string,
    @Param('noteId', uuid) noteId: string,
    @Body(new ZodValidationPipe(UpdateNoteSchema)) body: UpdateNoteRequest,
  ): Promise<Note> {
    return this.notes.update({ clientId }, noteId, body);
  }

  @Delete(':noteId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  remove(
    @Param('id', uuid) clientId: string,
    @Param('noteId', uuid) noteId: string,
  ): Promise<void> {
    return this.notes.remove({ clientId }, noteId);
  }
}
