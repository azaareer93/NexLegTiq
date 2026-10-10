import { Injectable } from '@nestjs/common';
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
import { ClsService } from 'nestjs-cls';

import { assertAssignable, TaskAccessService } from './task-access.service';
import { dateOnly, TasksRepository, toDbDate } from './tasks.repository';
import type { RequestContext } from '../../common/context/request-context';
import {
  PermissionDeniedException,
  ResourceConflictException,
  ResourceNotFoundException,
  ValidationException,
} from '../../common/errors/app.exception';
import { PaginatedResult } from '../../common/http/paginated-result';
import { PrismaService } from '../../database/prisma.service';
import { UnitOfWork } from '../../database/unit-of-work';
import type { ScopedTransaction } from '../../database/unit-of-work';
import type { Prisma } from '../../generated/prisma/client';
import type { ClientInfo } from '../auth/client-info';
import { truncateUserAgent } from '../auth/client-info';
import { CaseAccessService } from '../legal-files/case-access.service';
import { todayIn } from '../legal-files/cases.service';

const EDITABLE = {
  title: true,
  description: true,
  dueDate: true,
  priority: true,
  assignedToId: true,
} satisfies Prisma.TaskSelect;

/** Tasks API (MVP-76, D-098). Access rules live in TaskAccessService. */
@Injectable()
export class TasksService {
  constructor(
    private readonly cls: ClsService<RequestContext>,
    private readonly uow: UnitOfWork,
    private readonly prisma: PrismaService,
    private readonly files: CaseAccessService,
    private readonly access: TaskAccessService,
    private readonly tasks: TasksRepository,
  ) {}

  async create(input: CreateTaskRequest, client: ClientInfo): Promise<Task> {
    const me = this.access.actorId();
    const fileId = input.fileId ?? null;
    if (fileId) await this.files.assertFileAccess(fileId, 'write');
    const assignedToId = input.assignedToId ?? me;
    if (assignedToId !== me) this.assertHolds('assign:task');
    const id = await this.uow.run(async (tx) => {
      await assertAssignable(tx, assignedToId, fileId);
      const { _max } = await tx.task.aggregate({
        where: { status: 'TODO' },
        _max: { sortOrder: true },
      });
      const task = await tx.task.create({
        data: {
          officeId: this.officeId(),
          fileId,
          title: input.title,
          description: input.description || null,
          dueDate: input.dueDate ? toDbDate(input.dueDate) : null,
          priority: input.priority,
          assignedToId,
          createdById: me,
          // ponytail: last in the office's TODO column; concurrent creates may share a position (ties order by due
          // date). A per-column counter if that ever shows.
          sortOrder: (_max.sortOrder ?? -1) + 1,
        },
        select: { id: true },
      });
      await tx.auditLog.create({
        data: this.audit(client, task.id, 'CREATE', null, {
          title: input.title,
          fileId,
          assignedToId,
        }),
      });
      await this.notifyAssigned(tx, assignedToId, task.id, input.title);
      return task.id;
    });
    return this.tasks.get(id);
  }

  async list(query: TaskQuery): Promise<PaginatedResult<Task>> {
    const filters: Prisma.TaskWhereInput = {
      ...(query.fileId && { fileId: query.fileId }),
      ...(query.assignee && {
        assignedToId: query.assignee === 'me' ? this.access.actorId() : query.assignee,
      }),
      ...(query.status && { status: query.status }),
      ...(query.priority && { priority: query.priority }),
      ...(query.dueBefore && { dueDate: { lte: toDbDate(query.dueBefore) } }),
    };
    if (query.overdue !== undefined) {
      const office = await this.prisma.db.office.findFirstOrThrow({ select: { timezone: true } });
      const today = toDbDate(todayIn(office.timezone, new Date()));
      // Spelled out both ways: NOT(…) would also drop open tasks without a due date (NULL comparison).
      filters.AND = [
        query.overdue
          ? { status: { not: 'DONE' }, dueDate: { lt: today } }
          : { OR: [{ status: 'DONE' }, { dueDate: null }, { dueDate: { gte: today } }] },
      ];
    }
    const { items, total } = await this.tasks.list(this.access.visibleWhere(), filters, query);
    return PaginatedResult.of(items, { page: query.page, limit: query.limit, total });
  }

  async get(id: string): Promise<Task> {
    await this.access.find(id);
    return this.tasks.get(id);
  }

  /** Edits the task; only changed fields are written and audited. A new assignee is checked and notified. */
  async update(id: string, input: UpdateTaskRequest, client: ClientInfo): Promise<Task> {
    const task = await this.access.findFor(id, 'edit');
    await this.uow.run(async (tx) => {
      const before = await tx.task.findFirst({ where: { id }, select: EDITABLE });
      if (!before) throw new ResourceNotFoundException();
      const { old, next } = changes(
        { ...before, dueDate: before.dueDate && dateOnly(before.dueDate) },
        { ...input, ...(input.description === '' && { description: null }) },
      );
      if (Object.keys(next).length === 0) return;
      const assignee = next['assignedToId'] as string | undefined;
      if (assignee) {
        this.assertHolds('assign:task');
        await assertAssignable(tx, assignee, task.fileId);
      }
      const { dueDate, ...rest } = next;
      await tx.task.update({
        where: { id },
        data: { ...rest, ...(dueDate !== undefined && { dueDate: toDbDateOrNull(dueDate) }) },
      });
      await tx.auditLog.create({ data: this.audit(client, id, 'UPDATE', old, next) });
      if (assignee) {
        const title = (next['title'] as string | undefined) ?? task.title;
        await this.notifyAssigned(tx, assignee, id, title);
      }
    });
    return this.tasks.get(id);
  }

  /**
   * Moves the task to a column. DONE sets `completedAt` and, on a file, adds TASK_COMPLETED to its timeline; leaving
   * DONE clears it.
   */
  async changeStatus(
    id: string,
    input: ChangeTaskStatusRequest,
    client: ClientInfo,
  ): Promise<Task> {
    const task = await this.access.findFor(id, 'status');
    if (task.status === input.status) return this.tasks.get(id);
    await this.uow.run(async (tx) => {
      const done = input.status === 'DONE';
      // Guarded on the status read above: a concurrent move makes this one fail instead of completing twice.
      const { count } = await tx.task.updateMany({
        where: { id, status: task.status },
        data: { status: input.status, completedAt: done ? new Date() : null },
      });
      if (count === 0) throw new ResourceConflictException('RES-003');
      if (done && task.fileId) {
        await tx.caseTimelineEvent.create({
          data: {
            officeId: this.officeId(),
            fileId: task.fileId,
            eventType: 'TASK_COMPLETED',
            sourceType: 'Task',
            sourceId: id,
            actorId: this.access.actorId(),
            payload: { title: task.title },
          },
        });
      }
      await tx.auditLog.create({
        data: this.audit(client, id, 'UPDATE', { status: task.status }, { status: input.status }),
      });
    });
    return this.tasks.get(id);
  }

  async remove(id: string, client: ClientInfo): Promise<void> {
    const task = await this.access.findFor(id, 'edit');
    await this.uow.run(async (tx) => {
      const { count } = await tx.task.deleteMany({ where: { id } });
      if (count === 0) throw new ResourceNotFoundException();
      await tx.auditLog.create({
        data: this.audit(client, id, 'DELETE', { title: task.title, fileId: task.fileId }, null),
      });
    });
  }

  /** Positions 0, 1, 2… for the tasks of one column, in the order sent. Every task must be editable and in it. */
  async reorder(input: ReorderTasksRequest): Promise<void> {
    const tasks = await this.access.findAllFor(input.taskIds);
    if (tasks.some((task) => task.status !== input.status)) {
      throw new ValidationException([{ field: 'taskIds', message: 'validation.taskColumn' }]);
    }
    await this.uow.run(async (tx) => {
      for (const [sortOrder, id] of input.taskIds.entries()) {
        await tx.task.updateMany({ where: { id }, data: { sortOrder } });
      }
    });
  }

  /** Assigns every task to one colleague, all or nothing; each newly assigned task is audited and notified. */
  async bulkAssign(input: BulkAssignTasksRequest, client: ClientInfo): Promise<BulkAssignResult> {
    const tasks = await this.access.findAllFor(input.taskIds);
    const changed = tasks.filter((task) => task.assignedToId !== input.assignedToId);
    await this.uow.run(async (tx) => {
      for (const fileId of new Set(tasks.map((task) => task.fileId))) {
        await assertAssignable(tx, input.assignedToId, fileId);
      }
      for (const task of changed) {
        await tx.task.update({
          where: { id: task.id },
          data: { assignedToId: input.assignedToId },
        });
        await tx.auditLog.create({
          data: this.audit(
            client,
            task.id,
            'UPDATE',
            { assignedToId: task.assignedToId },
            { assignedToId: input.assignedToId },
          ),
        });
        await this.notifyAssigned(tx, input.assignedToId, task.id, task.title);
      }
    });
    return { updated: changed.length };
  }

  /** In-app `task.assigned` notification for a colleague (not for assigning to oneself). */
  private async notifyAssigned(
    tx: ScopedTransaction,
    userId: string,
    taskId: string,
    title: string,
  ): Promise<void> {
    if (userId === this.access.actorId()) return;
    await tx.notification.create({
      data: {
        officeId: this.officeId(),
        userId,
        type: 'task.assigned',
        titleKey: 'common.notifications.taskAssigned',
        params: { taskId, title },
      },
    });
  }

  private assertHolds(permission: 'assign:task'): void {
    if (!(this.cls.get('permissions') ?? []).includes(permission)) {
      throw new PermissionDeniedException();
    }
  }

  private audit(
    client: ClientInfo,
    entityId: string,
    action: 'CREATE' | 'UPDATE' | 'DELETE',
    oldValues: object | null,
    newValues: object | null,
  ) {
    return {
      officeId: this.officeId(),
      userId: this.access.actorId(),
      entityType: 'Task',
      entityId,
      action,
      ...(oldValues && { oldValues: JSON.parse(JSON.stringify(oldValues)) as object }),
      ...(newValues && { newValues: JSON.parse(JSON.stringify(newValues)) as object }),
      ipAddress: client.ip,
      userAgent: truncateUserAgent(client.userAgent),
      requestId: client.requestId,
    };
  }

  private officeId(): string {
    const officeId = this.cls.get('officeId');
    if (!officeId) throw new Error('No office in the request context');
    return officeId;
  }
}

/** The fields of `wanted` whose value differs from `current` (both plain values: dates as `YYYY-MM-DD`). */
function changes(current: Record<string, unknown>, wanted: Record<string, unknown>) {
  const old: Record<string, unknown> = {};
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(wanted)) {
    if (value !== undefined && current[key] !== value) {
      old[key] = current[key];
      next[key] = value;
    }
  }
  return { old, next };
}

const toDbDateOrNull = (value: unknown): Date | null =>
  typeof value === 'string' ? toDbDate(value) : null;
