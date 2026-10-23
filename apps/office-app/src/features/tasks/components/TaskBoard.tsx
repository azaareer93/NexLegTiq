import { HolderOutlined } from '@ant-design/icons';
import {
  closestCorners,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import type { Announcements, DragEndEvent } from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Task } from '@nexlegtiq/shared-contracts';
import { TASK_STATUSES } from '@nexlegtiq/shared-types';
import type { TaskStatus } from '@nexlegtiq/shared-types';
import { ErrorState, LoadingSkeleton, useApiErrorHandler, useFormat } from '@nexlegtiq/shared-ui';
import { isolate } from '@nexlegtiq/shared-utils';
import { App, Badge, Button, Flex, Typography } from 'antd';
import { useTranslation } from 'react-i18next';

import { TaskCard } from './TaskCard';
import { useMoveTask, useTaskColumn } from '../api/use-tasks';
import type { TaskScope } from '../api/use-tasks';
import { columnId, planMove } from '../board';
import type { Columns } from '../board';
import { openTaskDrawer } from '../task-drawer';

export interface BoardRights {
  /** `complete:task`: change a task's column. */
  readonly move: boolean;
  /** `create:task`: save the order inside a column (D-098). */
  readonly reorder: boolean;
  /** An archived file: nothing changes (D-052). */
  readonly readOnly: boolean;
}

function SortableCard({
  task,
  showFile,
  disabled,
  onMove,
  readOnly,
}: {
  readonly task: Task;
  readonly showFile: boolean;
  readonly disabled: boolean;
  readonly onMove?: (to: TaskStatus) => void;
  readonly readOnly: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task.id, disabled });
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
      }}
    >
      <TaskCard
        task={task}
        showFile={showFile}
        onOpen={() => openTaskDrawer({ task, readOnly })}
        {...(onMove && { onMove })}
        handle={
          disabled ? null : (
            // A handle, not the whole card: the card holds a link and a menu (no nested controls).
            <Button
              ref={setActivatorNodeRef}
              type="text"
              size="small"
              icon={<HolderOutlined />}
              style={{ cursor: 'grab' }}
              {...attributes}
              {...listeners}
              aria-label={t('tasks.card.drag', { title: isolate(task.title) })}
              data-testid={`task-drag-${task.id}`}
            />
          )
        }
      />
    </div>
  );
}

function Column({
  status,
  tasks,
  children,
}: {
  readonly status: TaskStatus;
  readonly tasks: readonly Task[];
  readonly children: React.ReactNode;
}): React.JSX.Element {
  const { t } = useTranslation();
  const format = useFormat();
  const { setNodeRef, isOver } = useDroppable({ id: columnId(status) });
  return (
    <section
      ref={setNodeRef}
      aria-label={t(`enums.taskStatus.${status}`)}
      data-testid={`task-column-${status}`}
      style={{
        flex: '1 1 240px',
        minInlineSize: 240,
        padding: 8,
        borderRadius: 8,
        background: isOver ? 'var(--nlq-color-primary-bg)' : 'var(--nlq-color-fill-quaternary)',
      }}
    >
      <Flex justify="space-between" align="center" style={{ marginBlockEnd: 8 }}>
        <Typography.Title level={2} style={{ fontSize: 14, margin: 0 }}>
          {t(`enums.taskStatus.${status}`)}
        </Typography.Title>
        <Badge
          count={format.number(tasks.length)}
          showZero
          color="var(--nlq-color-text-quaternary)"
        />
      </Flex>
      <SortableContext items={tasks.map((task) => task.id)} strategy={verticalListSortingStrategy}>
        <Flex vertical gap={8} style={{ minBlockSize: 48 }}>
          {children}
        </Flex>
      </SortableContext>
    </section>
  );
}

/** The four columns, each its own query (the first 100 tasks of that status, in Kanban order). */
function useBoardColumns(scope: TaskScope) {
  const queries = {
    TODO: useTaskColumn(scope, 'TODO'),
    IN_PROGRESS: useTaskColumn(scope, 'IN_PROGRESS'),
    BLOCKED: useTaskColumn(scope, 'BLOCKED'),
    DONE: useTaskColumn(scope, 'DONE'),
  };
  const columns: Columns = {
    TODO: queries.TODO.data?.items ?? [],
    IN_PROGRESS: queries.IN_PROGRESS.data?.items ?? [],
    BLOCKED: queries.BLOCKED.data?.items ?? [],
    DONE: queries.DONE.data?.items ?? [],
  };
  return { queries, columns };
}

/** Screen-reader messages for keyboard dragging, in the reader's language. */
function useAnnouncements(columns: Columns): Announcements {
  const { t } = useTranslation();
  const title = (id: string | number) =>
    isolate(TASK_STATUSES.flatMap((s) => columns[s]).find((task) => task.id === id)?.title ?? '');
  const place = (id: string | number | undefined) => {
    const status = TASK_STATUSES.find(
      (s) => columnId(s) === id || columns[s].some((x) => x.id === id),
    );
    return status ? t(`enums.taskStatus.${status}`) : '';
  };
  return {
    onDragStart: ({ active }) => t('tasks.dnd.picked', { title: title(active.id) }),
    onDragOver: ({ active, over }) =>
      over ? t('tasks.dnd.over', { title: title(active.id), place: place(over.id) }) : undefined,
    onDragEnd: ({ active, over }) =>
      over ? t('tasks.dnd.dropped', { title: title(active.id), place: place(over.id) }) : undefined,
    onDragCancel: ({ active }) => t('tasks.dnd.cancelled', { title: title(active.id) }),
  };
}

/**
 * The Kanban (D-012, `@dnd-kit`): four columns, drag between and within them with a pointer or the keyboard (Space,
 * arrows, Space), or "Move to" on a card. Moves are optimistic and rolled back when the API refuses.
 */
export function TaskBoard({
  scope,
  rights,
}: {
  readonly scope: TaskScope;
  readonly rights: BoardRights;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const { notify, referenceOf } = useApiErrorHandler();
  const { queries, columns } = useBoardColumns(scope);
  const move = useMoveTask(scope);
  const announcements = useAnnouncements(columns);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const canMove = rights.move && !rights.readOnly;

  const send = (plan: ReturnType<typeof planMove>) => {
    // Without `create:task` a card only changes column; its place inside one is not saved (D-098).
    if (!plan || (plan.task.status === plan.to && !rights.reorder)) return;
    move.mutate(
      { ...plan, reorder: rights.reorder },
      { onSuccess: () => void message.success(t('tasks.card.moved')), onError: notify },
    );
  };
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (over) send(planMove(columns, String(active.id), String(over.id)));
  };
  const moveTo = (task: Task) => (to: TaskStatus) => send(planMove(columns, task.id, columnId(to)));

  const failed = TASK_STATUSES.find((status) => queries[status].isError);
  if (failed) {
    return (
      <ErrorState
        requestId={referenceOf(queries[failed].error)}
        onRetry={() => TASK_STATUSES.forEach((status) => void queries[status].refetch())}
      />
    );
  }
  if (TASK_STATUSES.some((status) => queries[status].isPending))
    return <LoadingSkeleton rows={6} />;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragEnd={onDragEnd}
      accessibility={{
        announcements,
        screenReaderInstructions: { draggable: t('tasks.dnd.instructions') },
      }}
    >
      <Flex gap={12} wrap align="start" data-testid="task-board">
        {TASK_STATUSES.map((status) => (
          <Column key={status} status={status} tasks={columns[status]}>
            {columns[status].map((task) => (
              <SortableCard
                key={task.id}
                task={task}
                showFile={!('fileId' in scope)}
                disabled={!canMove}
                readOnly={rights.readOnly}
                {...(canMove && { onMove: moveTo(task) })}
              />
            ))}
          </Column>
        ))}
      </Flex>
    </DndContext>
  );
}
