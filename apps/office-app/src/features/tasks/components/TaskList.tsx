import type { TaskListParams } from '@nexlegtiq/shared-api-client';
import type { Task } from '@nexlegtiq/shared-contracts';
import { PRIORITIES, TASK_STATUSES } from '@nexlegtiq/shared-types';
import {
  Bdi,
  EmptyState,
  ErrorState,
  Ltr,
  PriorityTag,
  useApiErrorHandler,
} from '@nexlegtiq/shared-ui';
import { Button, DatePicker, Flex, Select, Switch, Table, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import dayjs from 'dayjs';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { DueDate } from './TaskCard';
import { useDirectory } from '../../cases/api/use-cases';
import { useTaskList } from '../api/use-tasks';
import type { TaskScope } from '../api/use-tasks';
import { openTaskDrawer } from '../task-drawer';

export const LIST_PAGE_SIZE = 20;

/** The list's filters, under the API's own parameter names (D-113). */
export type TaskFilters = Pick<
  TaskListParams,
  'status' | 'priority' | 'assignee' | 'dueBefore' | 'overdue' | 'page'
>;

function Filters({
  value,
  onChange,
  byAssignee,
}: {
  readonly value: TaskFilters;
  readonly onChange: (next: TaskFilters) => void;
  /** Only on a file: My tasks are the caller's by definition. */
  readonly byAssignee: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const people = useDirectory(byAssignee);
  // Any change goes back to the first page.
  const set = (key: keyof TaskFilters, next: string | undefined) => {
    const { [key]: _old, page: _page, ...rest } = value;
    onChange(next ? { ...rest, [key]: next } : rest);
  };
  return (
    <Flex gap={8} wrap align="center" data-testid="task-filters">
      <Select
        allowClear
        placeholder={t('tasks.filters.status')}
        aria-label={t('tasks.filters.status')}
        value={value.status}
        onChange={(next?: string) => set('status', next)}
        options={TASK_STATUSES.map((s) => ({ value: s, label: t(`enums.taskStatus.${s}`) }))}
        style={{ minInlineSize: 150 }}
        data-testid="task-filter-status"
      />
      <Select
        allowClear
        placeholder={t('tasks.filters.priority')}
        aria-label={t('tasks.filters.priority')}
        value={value.priority}
        onChange={(next?: string) => set('priority', next)}
        options={PRIORITIES.map((p) => ({ value: p, label: t(`enums.priority.${p}`) }))}
        style={{ minInlineSize: 150 }}
        data-testid="task-filter-priority"
      />
      {byAssignee ? (
        <Select
          allowClear
          showSearch={{ optionFilterProp: 'label' }}
          placeholder={t('tasks.filters.assignee')}
          aria-label={t('tasks.filters.assignee')}
          value={value.assignee}
          onChange={(next?: string) => set('assignee', next)}
          options={(people.data ?? []).map((person) => ({
            value: person.id,
            label: person.fullName,
          }))}
          style={{ minInlineSize: 180 }}
          data-testid="task-filter-assignee"
        />
      ) : null}
      <DatePicker
        placeholder={t('tasks.filters.dueBefore')}
        aria-label={t('tasks.filters.dueBefore')}
        value={value.dueBefore ? dayjs(value.dueBefore) : null}
        onChange={(date) => set('dueBefore', date ? date.format('YYYY-MM-DD') : undefined)}
        data-testid="task-filter-due"
      />
      <Flex gap={4} align="center">
        <Switch
          checked={value.overdue === 'true'}
          onChange={(on) => set('overdue', on ? 'true' : undefined)}
          aria-label={t('tasks.filters.overdue')}
          data-testid="task-filter-overdue"
        />
        <Typography.Text>{t('tasks.filters.overdue')}</Typography.Text>
      </Flex>
    </Flex>
  );
}

/** The table's columns; the file column only on My tasks (a file's tab is that file). */
function useColumns(onFile: boolean, readOnly: boolean): TableColumnsType<Task> {
  const { t } = useTranslation();
  return [
    {
      key: 'title',
      title: t('tasks.list.title'),
      render: (_, task) => (
        <Typography.Link
          onClick={() => openTaskDrawer({ task, readOnly })}
          data-testid={`task-row-${task.id}`}
        >
          <Bdi>{task.title}</Bdi>
        </Typography.Link>
      ),
    },
    ...(onFile
      ? []
      : [
          {
            key: 'file',
            title: t('tasks.list.file'),
            render: (_: unknown, task: Task) =>
              task.file ? (
                <Link to={`/cases/${task.file.id}`}>
                  <Ltr>{task.file.fileNumber}</Ltr>
                </Link>
              ) : (
                t('tasks.card.personal')
              ),
          },
        ]),
    {
      key: 'status',
      title: t('tasks.list.status'),
      render: (_, task) => t(`enums.taskStatus.${task.status}`),
    },
    {
      key: 'priority',
      title: t('tasks.list.priority'),
      render: (_, task) => <PriorityTag priority={task.priority} />,
    },
    {
      key: 'assignee',
      title: t('tasks.list.assignee'),
      render: (_, task) => <Bdi>{task.assignedTo.fullName}</Bdi>,
    },
    {
      key: 'due',
      title: t('tasks.list.due'),
      render: (_, task) => <DueDate task={task} />,
    },
  ];
}

/** The list view: filters, a paginated table, an empty state that tells "nothing yet" from "nothing matches". */
export function TaskList({
  scope,
  filters,
  onFilters,
  readOnly,
}: {
  readonly scope: TaskScope;
  readonly filters: TaskFilters;
  readonly onFilters: (next: TaskFilters) => void;
  readonly readOnly: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { referenceOf } = useApiErrorHandler();
  const onFile = 'fileId' in scope;
  const list = useTaskList(scope, { ...filters, limit: String(LIST_PAGE_SIZE) });
  const filtered = Object.keys(filters).some((key) => key !== 'page');

  const columns = useColumns(onFile, readOnly);

  let body: React.ReactNode;
  if (list.isError) {
    body = <ErrorState requestId={referenceOf(list.error)} onRetry={() => void list.refetch()} />;
  } else if (list.data?.items.length === 0) {
    body = filtered ? (
      <EmptyState
        title={t('tasks.noMatch')}
        action={<Button onClick={() => onFilters({})}>{t('tasks.clear')}</Button>}
      />
    ) : (
      <EmptyState title={t('tasks.empty')} description={t('tasks.emptyHint')} />
    );
  } else {
    body = (
      <Table<Task>
        rowKey="id"
        columns={columns}
        dataSource={list.data?.items ?? []}
        loading={list.isFetching}
        scroll={{ x: 'max-content' }}
        pagination={{
          current: Number(filters.page ?? 1),
          pageSize: LIST_PAGE_SIZE,
          total: list.data?.pagination.total ?? 0,
          showSizeChanger: false,
          onChange: (page) => onFilters({ ...filters, page: String(page) }),
        }}
        data-testid="task-list"
      />
    );
  }
  return (
    <Flex vertical gap={12}>
      <Filters value={filters} onChange={onFilters} byAssignee={onFile} />
      {body}
    </Flex>
  );
}
