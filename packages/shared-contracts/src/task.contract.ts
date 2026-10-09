import { PRIORITIES, TASK_STATUSES } from '@nexlegtiq/shared-types';
import { z } from 'zod';

import { longText, plainText } from './fields.js';

/** Calendar date `YYYY-MM-DD` (D-092): a deadline, the same day in every time zone. */
const DateOnlySchema = z.iso.date();

const TaskIdsSchema = z
  .array(z.uuid())
  .min(1, 'validation.required')
  .max(100, 'validation.tooLong')
  .refine((ids) => new Set(ids).size === ids.length, 'validation.duplicate');

/**
 * `POST /tasks` (D-098). Without `fileId` the task is personal (seen by its creator and assignee only); without
 * `assignedToId` it is the creator's. The assignee must be an active colleague who can see the file.
 */
export const CreateTaskSchema = z.object({
  title: plainText(300),
  description: longText(5000).optional(),
  fileId: z.uuid().optional(),
  dueDate: DateOnlySchema.optional(),
  priority: z.enum(PRIORITIES).default('MEDIUM'),
  assignedToId: z.uuid().optional(),
});
export type CreateTaskRequest = z.infer<typeof CreateTaskSchema>;

/** `PATCH /tasks/:id`. The status has its own route; `null` clears an optional field. */
export const UpdateTaskSchema = z
  .object({
    title: plainText(300),
    description: longText(5000).nullable(),
    dueDate: DateOnlySchema.nullable(),
    priority: z.enum(PRIORITIES),
    assignedToId: z.uuid(),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, 'validation.required');
export type UpdateTaskRequest = z.infer<typeof UpdateTaskSchema>;

/** `PATCH /tasks/:id/status`: moves the task to a Kanban column; DONE sets `completedAt`, leaving DONE clears it. */
export const ChangeTaskStatusSchema = z.object({ status: z.enum(TASK_STATUSES) });
export type ChangeTaskStatusRequest = z.infer<typeof ChangeTaskStatusSchema>;

/** `PATCH /tasks/reorder`: the tasks of one column in their new order (positions 0, 1, 2…). */
export const ReorderTasksSchema = z.object({
  status: z.enum(TASK_STATUSES),
  taskIds: TaskIdsSchema,
});
export type ReorderTasksRequest = z.infer<typeof ReorderTasksSchema>;

/** `POST /tasks/bulk-assign`: all or nothing. */
export const BulkAssignTasksSchema = z.object({
  taskIds: TaskIdsSchema,
  assignedToId: z.uuid(),
});
export type BulkAssignTasksRequest = z.infer<typeof BulkAssignTasksSchema>;

export const BulkAssignResultSchema = z.object({ updated: z.number().int() });
export type BulkAssignResult = z.infer<typeof BulkAssignResultSchema>;

/**
 * `GET /tasks` (api-conventions.md). `assignee=me` is "My tasks"; `dueBefore` includes that day; `overdue=true` keeps
 * open tasks due before today in the office's time zone. Ordered by Kanban position, then due date.
 */
export const TaskQuerySchema = z.object({
  fileId: z.uuid().optional(),
  assignee: z.union([z.literal('me'), z.uuid()]).optional(),
  status: z.enum(TASK_STATUSES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  dueBefore: DateOnlySchema.optional(),
  overdue: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type TaskQuery = z.infer<typeof TaskQuerySchema>;

const PersonSchema = z.object({ id: z.uuid(), fullName: z.string() });

/** A task, in lists and alone. */
export const TaskSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  description: z.string().nullable(),
  file: z.object({ id: z.uuid(), fileNumber: z.string(), title: z.string() }).nullable(),
  dueDate: DateOnlySchema.nullable(),
  priority: z.enum(PRIORITIES),
  status: z.enum(TASK_STATUSES),
  assignedTo: PersonSchema,
  createdBy: PersonSchema,
  completedAt: z.iso.datetime().nullable(),
  sortOrder: z.number().int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Task = z.infer<typeof TaskSchema>;
