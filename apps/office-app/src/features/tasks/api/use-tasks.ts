import { tasksApi } from '@nexlegtiq/shared-api-client';
import type { Page, TaskListParams } from '@nexlegtiq/shared-api-client';
import type { CreateTaskRequest, Task, UpdateTaskRequest } from '@nexlegtiq/shared-contracts';
import type { TaskStatus } from '@nexlegtiq/shared-types';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';

import { apiClient } from '../../auth';

const tasks = tasksApi(apiClient);

/** Whose tasks: one file's (its Tasks tab) or the caller's across files (`/tasks`). */
export type TaskScope = { readonly fileId: string } | { readonly assignee: 'me' };

export const scopeParams = (scope: TaskScope): TaskListParams =>
  'fileId' in scope ? { fileId: scope.fileId } : { assignee: 'me' };

/** Under `tasks`: the realtime bridge refreshes every query of this prefix on `task.*` events (D-129). */
export const taskKeys = {
  all: ['tasks'] as const,
  board: (scope: TaskScope) => [...taskKeys.all, 'board', scopeParams(scope)] as const,
  column: (scope: TaskScope, status: TaskStatus) => [...taskKeys.board(scope), status] as const,
  list: (scope: TaskScope, params: TaskListParams) =>
    [...taskKeys.all, 'list', scopeParams(scope), params] as const,
};

/** A column shows its first 100 tasks (the API's page limit), in Kanban order. */
export const COLUMN_LIMIT = 100;

export const useTaskColumn = (scope: TaskScope, status: TaskStatus) =>
  useQuery({
    queryKey: taskKeys.column(scope, status),
    queryFn: ({ signal }) =>
      tasks.list({ ...scopeParams(scope), status, limit: String(COLUMN_LIMIT) }, signal),
  });

export const useTaskList = (scope: TaskScope, params: TaskListParams) =>
  useQuery({
    queryKey: taskKeys.list(scope, params),
    queryFn: ({ signal }) => tasks.list({ ...params, ...scopeParams(scope) }, signal),
    placeholderData: keepPreviousData,
  });

function useTaskWrite<A, R>(write: (args: A) => Promise<R>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: write,
    onSettled: () => void queryClient.invalidateQueries({ queryKey: taskKeys.all }),
  });
}

export const useCreateTask = () => useTaskWrite((body: CreateTaskRequest) => tasks.create(body));

export const useUpdateTask = () =>
  useTaskWrite(({ id, body }: { id: string; body: UpdateTaskRequest }) => tasks.update(id, body));

export const useDeleteTask = () => useTaskWrite((id: string) => tasks.remove(id));

/** A card moved on the board: to `to`, with that column's tasks in `order` (the moved one included). */
export interface TaskMove {
  readonly task: Task;
  readonly to: TaskStatus;
  readonly order: readonly string[];
  /** Positions are saved only with `create:task` (D-098); a status move needs `complete:task` alone. */
  readonly reorder: boolean;
}

type Snapshot = [readonly unknown[], Page<Task> | undefined][];

/** The board as the move leaves it: the task out of its column and into `to`, in `order`. */
function applyMove(queryClient: QueryClient, scope: TaskScope, move: TaskMove): void {
  const { task, to, order } = move;
  queryClient.setQueryData<Page<Task>>(taskKeys.column(scope, task.status), (page) =>
    page && task.status !== to
      ? { ...page, items: page.items.filter((item) => item.id !== task.id) }
      : page,
  );
  queryClient.setQueryData<Page<Task>>(taskKeys.column(scope, to), (page) => {
    if (!page) return page;
    const byId = new Map([...page.items, { ...task, status: to }].map((item) => [item.id, item]));
    const items = order.flatMap((id) => byId.get(id) ?? []);
    return { ...page, items };
  });
}

/**
 * Moves a card optimistically: the board changes at once, then the status (and the column's order) is saved; a refusal
 * (403 AUTH-100 for a task the caller may not move, 422 BIZ-007 on an archived file…) puts the board back as it was.
 */
export function useMoveTask(scope: TaskScope) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (move: TaskMove) => {
      if (move.task.status !== move.to) await tasks.changeStatus(move.task.id, move.to);
      if (move.reorder) await tasks.reorder(move.to, move.order);
    },
    onMutate: async (move): Promise<Snapshot> => {
      await queryClient.cancelQueries({ queryKey: taskKeys.board(scope) });
      const snapshot = queryClient.getQueriesData<Page<Task>>({ queryKey: taskKeys.board(scope) });
      applyMove(queryClient, scope, move);
      return snapshot;
    },
    onError: (_error, _move, snapshot) => {
      for (const [key, data] of snapshot ?? []) queryClient.setQueryData(key, data);
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: taskKeys.all }),
  });
}
