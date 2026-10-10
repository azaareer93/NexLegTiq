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
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiNoContentResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  BulkAssignResultSchema,
  BulkAssignTasksSchema,
  ChangeTaskStatusSchema,
  CreateTaskSchema,
  ReorderTasksSchema,
  TaskQuerySchema,
  TaskSchema,
  UpdateTaskSchema,
} from '@nexlegtiq/shared-contracts';
import type {
  BulkAssignResult,
  BulkAssignTasksRequest,
  ChangeTaskStatusRequest,
  CreateTaskRequest,
  ReorderTasksRequest,
  Task,
  TaskQuery,
  UpdateTaskRequest,
} from '@nexlegtiq/shared-contracts';
import type { Request } from 'express';
import { ClsService } from 'nestjs-cls';

import { TasksService } from './tasks.service';
import type { RequestContext } from '../../common/context/request-context';
import { ResourceNotFoundException } from '../../common/errors/app.exception';
import type { PaginatedResult } from '../../common/http/paginated-result';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe';
import { ApiZodBody, ApiZodQuery, ApiZodResponse } from '../../common/openapi/api-zod.decorators';
import {
  PermissionConditionsCheckedByService,
  RequireAnyPermission,
  RequirePermissions,
} from '../../common/rbac/permissions.decorator';
import { clientFromRequest } from '../auth/client-info';
import type { ClientInfo } from '../auth/client-info';

/** A malformed id is the same 404 as an unknown one (D-019). */
const taskId = new ParseUUIDPipe({ exceptionFactory: () => new ResourceNotFoundException() });

/** Tasks (api-conventions.md#tasks, MVP-76, D-098). Access follows the task's file; personal tasks their owners. */
@ApiTags('tasks')
@ApiBearerAuth('JWT')
@Controller('tasks')
export class TasksController {
  constructor(
    private readonly tasks: TasksService,
    private readonly cls: ClsService<RequestContext>,
  ) {}

  @Post()
  @RequirePermissions('create:task')
  @ApiOperation({ summary: 'Create a task on a file, or a personal one' })
  @ApiZodBody(CreateTaskSchema)
  @ApiZodResponse(HttpStatus.CREATED, TaskSchema)
  create(
    @Body(new ZodValidationPipe(CreateTaskSchema)) body: CreateTaskRequest,
    @Req() req: Request,
  ): Promise<Task> {
    return this.tasks.create(body, this.client(req));
  }

  @Get()
  @RequireAnyPermission('view:all:cases', 'view:assigned:cases')
  @ApiOperation({ summary: 'Tasks the caller may see (a file, my tasks, overdue…)' })
  @ApiZodQuery(TaskQuerySchema)
  @ApiZodResponse(HttpStatus.OK, TaskSchema, { paginated: true })
  list(
    @Query(new ZodValidationPipe(TaskQuerySchema)) query: TaskQuery,
  ): Promise<PaginatedResult<Task>> {
    return this.tasks.list(query);
  }

  // Before `:id` routes: Nest matches in declaration order.
  @Patch('reorder')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('create:task')
  @ApiOperation({ summary: 'Set the order of the tasks of one Kanban column' })
  @ApiZodBody(ReorderTasksSchema)
  @ApiNoContentResponse({ description: 'Reordered' })
  reorder(
    @Body(new ZodValidationPipe(ReorderTasksSchema)) body: ReorderTasksRequest,
  ): Promise<void> {
    return this.tasks.reorder(body);
  }

  @Post('bulk-assign')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('assign:task')
  @ApiOperation({ summary: 'Assign several tasks to one colleague (all or nothing)' })
  @ApiZodBody(BulkAssignTasksSchema)
  @ApiZodResponse(HttpStatus.OK, BulkAssignResultSchema)
  bulkAssign(
    @Body(new ZodValidationPipe(BulkAssignTasksSchema)) body: BulkAssignTasksRequest,
    @Req() req: Request,
  ): Promise<BulkAssignResult> {
    return this.tasks.bulkAssign(body, this.client(req));
  }

  @Get(':id')
  @RequireAnyPermission('view:all:cases', 'view:assigned:cases')
  @ApiOperation({ summary: 'A task (404 if not visible)' })
  @ApiZodResponse(HttpStatus.OK, TaskSchema)
  get(@Param('id', taskId) id: string): Promise<Task> {
    return this.tasks.get(id);
  }

  @Patch(':id/status')
  @RequirePermissions('complete:task')
  @PermissionConditionsCheckedByService()
  @ApiOperation({
    summary: 'Move a task to a column; DONE completes it (BIZ-007 when the file is archived)',
  })
  @ApiZodBody(ChangeTaskStatusSchema)
  @ApiZodResponse(HttpStatus.OK, TaskSchema)
  changeStatus(
    @Param('id', taskId) id: string,
    @Body(new ZodValidationPipe(ChangeTaskStatusSchema)) body: ChangeTaskStatusRequest,
    @Req() req: Request,
  ): Promise<Task> {
    return this.tasks.changeStatus(id, body, this.client(req));
  }

  @Patch(':id')
  @RequirePermissions('create:task')
  @ApiOperation({ summary: 'Edit or reassign a task (BIZ-007 when the file is archived)' })
  @ApiZodBody(UpdateTaskSchema)
  @ApiZodResponse(HttpStatus.OK, TaskSchema)
  update(
    @Param('id', taskId) id: string,
    @Body(new ZodValidationPipe(UpdateTaskSchema)) body: UpdateTaskRequest,
    @Req() req: Request,
  ): Promise<Task> {
    return this.tasks.update(id, body, this.client(req));
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('create:task')
  @ApiOperation({ summary: 'Delete a task (BIZ-007 when the file is archived)' })
  @ApiNoContentResponse({ description: 'Deleted' })
  remove(@Param('id', taskId) id: string, @Req() req: Request): Promise<void> {
    return this.tasks.remove(id, this.client(req));
  }

  private client(req: Request): ClientInfo {
    return clientFromRequest(req, this.cls.isActive() ? this.cls.getId() : null);
  }
}
