import type { Task } from '@nexlegtiq/shared-contracts';
import { TASK_STATUSES } from '@nexlegtiq/shared-types';
import type { TaskStatus } from '@nexlegtiq/shared-types';

export type Columns = Readonly<Record<TaskStatus, readonly Task[]>>;

/** The droppable id of a column (its empty space and header), next to the cards' own ids. */
export const columnId = (status: TaskStatus): string => `column-${status}`;

const statusOfColumnId = (id: string): TaskStatus | undefined =>
  TASK_STATUSES.find((status) => columnId(status) === id);

/**
 * Where a drop lands (D-012 board): `overId` is a card (before it) or a column (at its end). Null when nothing changes
 * or the ids are unknown.
 */
export function planMove(
  columns: Columns,
  activeId: string,
  overId: string,
): { task: Task; to: TaskStatus; order: string[] } | null {
  const from = TASK_STATUSES.find((status) => columns[status].some((t) => t.id === activeId));
  if (!from || activeId === overId) return null;
  const task = columns[from].find((t) => t.id === activeId) as Task;
  const to =
    statusOfColumnId(overId) ??
    TASK_STATUSES.find((status) => columns[status].some((t) => t.id === overId));
  if (!to) return null;
  const before = columns[to].map((t) => t.id);
  const rest = before.filter((id) => id !== activeId);
  const index = rest.indexOf(overId);
  // Within a column, dropping on a card further down puts the task after it (as the sortable list shows).
  const after = from === to && before.indexOf(overId) > before.indexOf(activeId);
  const at = index === -1 ? rest.length : index + (after ? 1 : 0);
  const order = [...rest.slice(0, at), activeId, ...rest.slice(at)];
  if (from === to && order.every((id, i) => id === before[i])) return null;
  return { task, to, order };
}

/** Open and due before today (the office's calendar day, D-092): shown with an icon and a word, never colour alone. */
export const isOverdue = (task: Pick<Task, 'dueDate' | 'status'>, today: string): boolean =>
  task.dueDate !== null && task.status !== 'DONE' && task.dueDate < today;
