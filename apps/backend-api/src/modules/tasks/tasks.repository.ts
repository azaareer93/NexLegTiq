import { Injectable } from '@nestjs/common';
import type { Task, TaskQuery } from '@nexlegtiq/shared-contracts';

import { PrismaService } from '../../database/prisma.service';
import type { Prisma } from '../../generated/prisma/client';

const PERSON = { select: { id: true, fullName: true } } as const;

const TASK_SELECT = {
  id: true,
  title: true,
  description: true,
  dueDate: true,
  priority: true,
  status: true,
  completedAt: true,
  sortOrder: true,
  createdAt: true,
  updatedAt: true,
  file: { select: { id: true, fileNumber: true, title: true } },
  assignedTo: PERSON,
  createdBy: PERSON,
} satisfies Prisma.TaskSelect;

type TaskRow = Prisma.TaskGetPayload<{ select: typeof TASK_SELECT }>;

/** `YYYY-MM-DD` of a `@db.Date` column (stored at UTC midnight). */
export const dateOnly = (value: Date): string => value.toISOString().slice(0, 10);
/** A `YYYY-MM-DD` calendar date as the `@db.Date` value Prisma writes. */
export const toDbDate = (value: string): Date => new Date(`${value}T00:00:00Z`);

/** Reads of tasks on the scoped client; callers pass the access `where` from TasksService. */
@Injectable()
export class TasksRepository {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    access: Prisma.TaskWhereInput,
    filters: Prisma.TaskWhereInput,
    query: Pick<TaskQuery, 'page' | 'limit'>,
  ): Promise<{ items: Task[]; total: number }> {
    const where: Prisma.TaskWhereInput = { AND: [access, filters] };
    const [rows, total] = await Promise.all([
      this.prisma.db.task.findMany({
        where,
        select: TASK_SELECT,
        orderBy: [
          { sortOrder: 'asc' },
          { dueDate: { sort: 'asc', nulls: 'last' } },
          { createdAt: 'asc' },
          { id: 'asc' },
        ],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.db.task.count({ where }),
    ]);
    return { items: rows.map(toTask), total };
  }

  async get(id: string): Promise<Task> {
    return toTask(
      await this.prisma.db.task.findFirstOrThrow({ where: { id }, select: TASK_SELECT }),
    );
  }
}

function toTask(row: TaskRow): Task {
  return {
    ...row,
    dueDate: row.dueDate && dateOnly(row.dueDate),
    completedAt: row.completedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
