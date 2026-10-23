import { ClockCircleOutlined, MoreOutlined } from '@ant-design/icons';
import type { Task } from '@nexlegtiq/shared-contracts';
import { TASK_STATUSES } from '@nexlegtiq/shared-types';
import type { TaskStatus } from '@nexlegtiq/shared-types';
import { Bdi, Ltr, PriorityTag, useFormat } from '@nexlegtiq/shared-ui';
import { isolate, wallClock } from '@nexlegtiq/shared-utils';
import { Button, Card, Dropdown, Flex, Tag, Typography } from 'antd';
import { useTranslation } from 'react-i18next';

import { useSession } from '../../auth';
import { isOverdue } from '../board';

/** Today in the office's time zone (D-092, D-127): a due date is a calendar day there. */
export function useOfficeToday(): string {
  const timeZone = useSession((state) => state.user?.timeZone) ?? 'Asia/Hebron';
  return wallClock(new Date(), timeZone).date;
}

/** Due date, red "overdue" tag with an icon and a word (never colour alone). */
export function DueDate({ task }: { readonly task: Task }): React.JSX.Element | null {
  const { t } = useTranslation();
  const format = useFormat();
  const today = useOfficeToday();
  if (!task.dueDate) return null;
  return (
    <Flex gap={4} align="center" wrap>
      <Typography.Text type="secondary">
        {t('tasks.card.due', { date: format.date(task.dueDate) })}
      </Typography.Text>
      {isOverdue(task, today) ? (
        <Tag
          color="error"
          icon={<ClockCircleOutlined aria-hidden />}
          data-testid={`overdue-${task.id}`}
        >
          {t('tasks.card.overdue')}
        </Tag>
      ) : null}
    </Flex>
  );
}

/** "Move to …": the keyboard- and touch-friendly way to change a task's column, next to dragging. */
function MoveMenu({
  task,
  onMove,
}: {
  readonly task: Task;
  readonly onMove: (to: TaskStatus) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <Dropdown
      trigger={['click']}
      menu={{
        items: TASK_STATUSES.filter((status) => status !== task.status).map((status) => ({
          key: status,
          label: (
            <span data-testid={`task-move-${task.id}-${status}`}>
              {t(`enums.taskStatus.${status}`)}
            </span>
          ),
        })),
        onClick: ({ key, domEvent }) => {
          domEvent.stopPropagation();
          onMove(key as TaskStatus);
        },
      }}
    >
      <Button
        type="text"
        size="small"
        icon={<MoreOutlined />}
        aria-label={t('tasks.card.moveTo', { title: isolate(task.title) })}
        onClick={(event) => event.stopPropagation()}
        data-testid={`task-menu-${task.id}`}
      />
    </Dropdown>
  );
}

/** A task on the board: title, file (on My tasks), due date, priority and assignee; opens the drawer. */
export function TaskCard({
  task,
  showFile,
  onOpen,
  onMove,
  handle,
}: {
  readonly task: Task;
  readonly showFile: boolean;
  readonly onOpen: () => void;
  /** Absent when the caller may not move tasks. */
  readonly onMove?: (to: TaskStatus) => void;
  /** The drag handle, on the board when the card can move. */
  readonly handle?: React.ReactNode;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <Card size="small" data-testid={`task-card-${task.id}`}>
      <Flex vertical gap={4}>
        <Flex justify="space-between" align="start" gap={4}>
          <Typography.Link
            onClick={onOpen}
            aria-label={t('tasks.card.open', { title: isolate(task.title) })}
            data-testid={`task-open-${task.id}`}
          >
            <Bdi>{task.title}</Bdi>
          </Typography.Link>
          <Flex>
            {handle}
            {onMove ? <MoveMenu task={task} onMove={onMove} /> : null}
          </Flex>
        </Flex>
        {showFile ? (
          <Typography.Text type="secondary">
            {task.file ? <Ltr>{task.file.fileNumber}</Ltr> : t('tasks.card.personal')}
          </Typography.Text>
        ) : null}
        <DueDate task={task} />
        <Flex gap={8} align="center" wrap>
          <PriorityTag priority={task.priority} />
          <Typography.Text type="secondary">
            <Bdi>{task.assignedTo.fullName}</Bdi>
          </Typography.Text>
        </Flex>
      </Flex>
    </Card>
  );
}
