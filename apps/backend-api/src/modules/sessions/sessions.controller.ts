import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  CancelSessionSchema,
  CreateSessionSchema,
  FileSessionsQuerySchema,
  SessionListItemSchema,
  SessionOutcomeSchema,
  SessionQuerySchema,
  SessionReminderSchema,
  SessionSchema,
  UpdateSessionSchema,
} from '@nexlegtiq/shared-contracts';
import type {
  CancelSessionRequest,
  CreateSessionRequest,
  FileSessionsQuery,
  Session,
  SessionListItem,
  SessionOutcomeRequest,
  SessionQuery,
  SessionReminder,
  UpdateSessionRequest,
} from '@nexlegtiq/shared-contracts';
import type { Request } from 'express';
import { ClsService } from 'nestjs-cls';

import { SessionRemindersService } from './session-reminders.service';
import { SessionsService } from './sessions.service';
import type { RequestContext } from '../../common/context/request-context';
import { ResourceNotFoundException } from '../../common/errors/app.exception';
import type { PaginatedResult } from '../../common/http/paginated-result';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe';
import { ApiZodBody, ApiZodQuery, ApiZodResponse } from '../../common/openapi/api-zod.decorators';
import { RequireAnyPermission, RequirePermissions } from '../../common/rbac/permissions.decorator';
import { clientFromRequest } from '../auth/client-info';
import type { ClientInfo } from '../auth/client-info';
import { AllowWhenReadOnly } from '../subscriptions/subscription.decorators';

/** A malformed id is the same 404 as an unknown one (D-019). */
const uuid = new ParseUUIDPipe({ exceptionFactory: () => new ResourceNotFoundException() });

/** Hearings (api-conventions.md#sessions, MVP-67, D-116). Access follows the session's file. */
@ApiTags('sessions')
@ApiBearerAuth('JWT')
@Controller('sessions')
export class SessionsController {
  constructor(
    private readonly sessions: SessionsService,
    private readonly reminders: SessionRemindersService,
    private readonly cls: ClsService<RequestContext>,
  ) {}

  @Post()
  @RequirePermissions('create:session')
  @ApiOperation({
    summary: 'Schedule a session (409 BIZ-004 when the lawyer is busy, unless acknowledged)',
  })
  @ApiZodBody(CreateSessionSchema)
  @ApiZodResponse(HttpStatus.CREATED, SessionSchema)
  create(
    @Body(new ZodValidationPipe(CreateSessionSchema)) body: CreateSessionRequest,
    @Req() req: Request,
  ): Promise<Session> {
    return this.sessions.create(body, this.client(req));
  }

  @Get()
  @RequireAnyPermission('view:all:cases', 'view:assigned:cases')
  @ApiOperation({ summary: 'Calendar: sessions in a time range on files the caller can see' })
  @ApiZodQuery(SessionQuerySchema)
  @ApiZodResponse(HttpStatus.OK, SessionListItemSchema.array())
  list(
    @Query(new ZodValidationPipe(SessionQuerySchema)) query: SessionQuery,
  ): Promise<SessionListItem[]> {
    return this.sessions.list(query);
  }

  @Get(':id')
  @RequireAnyPermission('view:all:cases', 'view:assigned:cases')
  @ApiOperation({ summary: 'A session (404 if its file is not visible)' })
  @ApiZodResponse(HttpStatus.OK, SessionSchema)
  get(@Param('id', uuid) id: string): Promise<Session> {
    return this.sessions.get(id);
  }

  @Patch(':id')
  @RequirePermissions('edit:session')
  @ApiOperation({
    summary:
      'Edit or reschedule a scheduled session (BIZ-004 on conflict, BIZ-012 when not scheduled)',
  })
  @ApiZodBody(UpdateSessionSchema)
  @ApiZodResponse(HttpStatus.OK, SessionSchema)
  update(
    @Param('id', uuid) id: string,
    @Body(new ZodValidationPipe(UpdateSessionSchema)) body: UpdateSessionRequest,
    @Req() req: Request,
  ): Promise<Session> {
    return this.sessions.update(id, body, this.client(req));
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('edit:session')
  @ApiOperation({ summary: 'Cancel a session and its pending reminders' })
  @ApiZodBody(CancelSessionSchema)
  @ApiZodResponse(HttpStatus.OK, SessionSchema)
  cancel(
    @Param('id', uuid) id: string,
    @Body(new ZodValidationPipe(CancelSessionSchema)) body: CancelSessionRequest,
    @Req() req: Request,
  ): Promise<Session> {
    return this.sessions.cancel(id, body, this.client(req));
  }

  @Post(':id/outcome')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('edit:session')
  @ApiOperation({ summary: 'Record the outcome and minutes; optionally schedule the next session' })
  @ApiZodBody(SessionOutcomeSchema)
  @ApiZodResponse(HttpStatus.OK, SessionSchema)
  recordOutcome(
    @Param('id', uuid) id: string,
    @Body(new ZodValidationPipe(SessionOutcomeSchema)) body: SessionOutcomeRequest,
    @Req() req: Request,
  ): Promise<Session> {
    return this.sessions.recordOutcome(id, body, this.client(req));
  }

  // Only a "seen" mark on the caller's own reminder (D-117): allowed while the office is read-only (D-122).
  @AllowWhenReadOnly()
  @Post('reminders/:id/ack')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Acknowledge one of my hearing reminders (404 if it is not mine)' })
  @ApiZodResponse(HttpStatus.OK, SessionReminderSchema)
  acknowledgeReminder(@Param('id', uuid) id: string): Promise<SessionReminder> {
    return this.reminders.acknowledge(id);
  }

  private client(req: Request): ClientInfo {
    return clientFromRequest(req, this.cls.isActive() ? this.cls.getId() : null);
  }
}

/** `GET /cases/:id/sessions` — the Sessions tab of a file. */
@ApiTags('sessions')
@ApiBearerAuth('JWT')
@Controller('cases')
export class FileSessionsController {
  constructor(private readonly sessions: SessionsService) {}

  @Get(':id/sessions')
  @RequireAnyPermission('view:all:cases', 'view:assigned:cases')
  @ApiOperation({ summary: "A file's upcoming or past sessions" })
  @ApiZodQuery(FileSessionsQuerySchema)
  @ApiZodResponse(HttpStatus.OK, SessionListItemSchema, { paginated: true })
  listForFile(
    @Param('id', uuid) id: string,
    @Query(new ZodValidationPipe(FileSessionsQuerySchema)) query: FileSessionsQuery,
  ): Promise<PaginatedResult<SessionListItem>> {
    return this.sessions.listForFile(id, query);
  }
}
