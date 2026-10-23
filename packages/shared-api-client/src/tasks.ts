import { TaskSchema } from '@nexlegtiq/shared-contracts';
import type {
  CreateTaskRequest,
  Task,
  TaskQuerySchema,
  UpdateTaskRequest,
} from '@nexlegtiq/shared-contracts';
import type { TaskStatus } from '@nexlegtiq/shared-types';
import type { z } from 'zod';

import type { ApiClient, Page } from './api-client.js';

/** `GET /tasks` as the app holds it: strings, checked by the API. */
export type TaskListParams = Partial<Record<keyof z.input<typeof TaskQuerySchema>, string>>;

/** Tasks (D-098): lists, writes, Kanban moves. */
export function tasksApi(client: ApiClient) {
  const path = (id: string) => `tasks/${encodeURIComponent(id)}`;
  return {
    list: (query: TaskListParams, signal?: AbortSignal): Promise<Page<Task>> =>
      client.requestPage({ method: 'GET', path: 'tasks', query, signal }, TaskSchema),
    create: (body: CreateTaskRequest): Promise<Task> =>
      client.request({ method: 'POST', path: 'tasks', body }, TaskSchema),
    update: (id: string, body: UpdateTaskRequest): Promise<Task> =>
      client.request({ method: 'PATCH', path: path(id), body }, TaskSchema),
    /** A move to another column (`complete:task`). */
    changeStatus: (id: string, status: TaskStatus): Promise<Task> =>
      client.request({ method: 'PATCH', path: `${path(id)}/status`, body: { status } }, TaskSchema),
    /** A column's tasks in their new order (`create:task`); 204. */
    reorder: (status: TaskStatus, taskIds: readonly string[]): Promise<void> =>
      client.request({ method: 'PATCH', path: 'tasks/reorder', body: { status, taskIds } }),
    remove: (id: string): Promise<void> => client.request({ method: 'DELETE', path: path(id) }),
  };
}
