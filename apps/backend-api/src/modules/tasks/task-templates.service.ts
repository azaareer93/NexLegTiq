import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Injectable,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiNoContentResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  CreateTaskTemplateSchema,
  TaskTemplateSchema,
  UpdateTaskTemplateSchema,
} from '@nexlegtiq/shared-contracts';
import type {
  CreateTaskTemplateRequest,
  TaskTemplate,
  UpdateTaskTemplateRequest,
} from '@nexlegtiq/shared-contracts';
import { ClsService } from 'nestjs-cls';

import { AuditService } from '../../common/audit/audit.service';
import { changes } from '../../common/audit/changes';
import type { RequestContext } from '../../common/context/request-context';
import { ResourceNotFoundException, ValidationException } from '../../common/errors/app.exception';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe';
import { ApiZodBody, ApiZodResponse } from '../../common/openapi/api-zod.decorators';
import { RequirePermissions } from '../../common/rbac/permissions.decorator';
import { PrismaService } from '../../database/prisma.service';
import { UnitOfWork } from '../../database/unit-of-work';

const SELECT = {
  id: true,
  name: true,
  fileType: true,
  defaultTitle: true,
  defaultDescription: true,
  dueDaysAfterOpen: true,
  defaultAssigneeRole: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} as const;

type Row = {
  id: string;
  name: string;
  fileType: TaskTemplate['fileType'];
  defaultTitle: string;
  defaultDescription: string | null;
  dueDaysAfterOpen: number | null;
  defaultAssigneeRole: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
};

const toTemplate = (row: Row): TaskTemplate => ({
  ...row,
  // An older row without a role means the responsible lawyer (D-095); MEMBER is never offered (D-156).
  defaultAssigneeRole: row.defaultAssigneeRole === 'PARALEGAL' ? 'PARALEGAL' : 'RESPONSIBLE_LAWYER',
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

/** The office's task templates (MVP-78, D-156); applied to new files by `applyTaskTemplates`. */
@Injectable()
export class TaskTemplatesService {
  constructor(
    private readonly cls: ClsService<RequestContext>,
    private readonly prisma: PrismaService,
    private readonly uow: UnitOfWork,
    private readonly audit: AuditService,
  ) {}

  async list(): Promise<TaskTemplate[]> {
    const rows = await this.prisma.db.taskTemplate.findMany({
      orderBy: [
        { fileType: { sort: 'asc', nulls: 'first' } },
        { dueDaysAfterOpen: 'asc' },
        { name: 'asc' },
      ],
      select: SELECT,
    });
    return rows.map(toTemplate);
  }

  async create(input: CreateTaskTemplateRequest): Promise<TaskTemplate> {
    const row = await this.uow.run(async (tx) => {
      const created = await tx.taskTemplate.create({
        data: { ...input, officeId: this.cls.get('officeId') as string },
        select: SELECT,
      });
      await this.audit.log(tx, {
        entityType: 'TaskTemplate',
        entityId: created.id,
        action: 'CREATE',
        newValues: input,
      });
      return created;
    });
    return toTemplate(row);
  }

  async update(id: string, input: UpdateTaskTemplateRequest): Promise<TaskTemplate> {
    if (Object.values(input).every((value) => value === undefined)) {
      throw new ValidationException([{ field: 'name', message: 'validation.required' }]);
    }
    const row = await this.uow.run(async (tx) => {
      const before = await tx.taskTemplate.findFirst({ where: { id }, select: SELECT });
      if (!before) throw new ResourceNotFoundException();
      const { old, next } = changes(before, input);
      if (Object.keys(next).length === 0) return before;
      const updated = await tx.taskTemplate.update({ where: { id }, data: next, select: SELECT });
      await this.audit.log(tx, {
        entityType: 'TaskTemplate',
        entityId: id,
        action: 'UPDATE',
        oldValues: old,
        newValues: next,
      });
      return updated;
    });
    return toTemplate(row);
  }

  /** Hard delete: tasks it made keep their `sourceId` (no FK) as history. */
  async remove(id: string): Promise<void> {
    await this.uow.run(async (tx) => {
      const { count } = await tx.taskTemplate.deleteMany({ where: { id } });
      if (count === 0) throw new ResourceNotFoundException();
      await this.audit.log(tx, { entityType: 'TaskTemplate', entityId: id, action: 'DELETE' });
    });
  }
}

const uuid = new ParseUUIDPipe({ exceptionFactory: () => new ResourceNotFoundException() });

/** `task-templates` CRUD (api-conventions.md#tasks, D-156): the office manager's (`manage:office`). */
@ApiTags('tasks')
@ApiBearerAuth('JWT')
@Controller('task-templates')
@RequirePermissions('manage:office')
export class TaskTemplatesController {
  constructor(private readonly templates: TaskTemplatesService) {}

  @Get()
  @ApiOperation({ summary: 'The office task templates, by file type' })
  @ApiZodResponse(HttpStatus.OK, TaskTemplateSchema.array())
  list(): Promise<TaskTemplate[]> {
    return this.templates.list();
  }

  @Post()
  @ApiZodBody(CreateTaskTemplateSchema)
  @ApiZodResponse(HttpStatus.CREATED, TaskTemplateSchema)
  create(
    @Body(new ZodValidationPipe(CreateTaskTemplateSchema)) body: CreateTaskTemplateRequest,
  ): Promise<TaskTemplate> {
    return this.templates.create(body);
  }

  @Patch(':id')
  @ApiZodBody(UpdateTaskTemplateSchema)
  @ApiZodResponse(HttpStatus.OK, TaskTemplateSchema)
  update(
    @Param('id', uuid) id: string,
    @Body(new ZodValidationPipe(UpdateTaskTemplateSchema)) body: UpdateTaskTemplateRequest,
  ): Promise<TaskTemplate> {
    return this.templates.update(id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  remove(@Param('id', uuid) id: string): Promise<void> {
    return this.templates.remove(id);
  }
}
