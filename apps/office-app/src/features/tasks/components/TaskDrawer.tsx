import { CreateTaskSchema } from '@nexlegtiq/shared-contracts';
import type { CreateTaskRequest, Task, UpdateTaskRequest } from '@nexlegtiq/shared-contracts';
import { PRIORITIES, permissionsFor } from '@nexlegtiq/shared-types';
import type { Priority } from '@nexlegtiq/shared-types';
import { Bdi, ConfirmModal, Ltr, useApiErrorHandler, useCan } from '@nexlegtiq/shared-ui';
import { isolate } from '@nexlegtiq/shared-utils';
import { App, Button, DatePicker, Drawer, Flex, Form, Input, Select, Typography } from 'antd';
import dayjs from 'dayjs';
import type { Dayjs } from 'dayjs';
import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { useSession } from '../../auth';
import { zodRule } from '../../auth/forms';
import { useDirectory } from '../../cases/api/use-cases';
import { useCreateTask, useDeleteTask, useUpdateTask } from '../api/use-tasks';
import { closeTaskDrawer, useTaskDrawer } from '../task-drawer';

interface Values {
  title: string;
  description?: string;
  dueDate?: Dayjs | null;
  priority: Priority;
  assignedToId?: string;
}

const day = (value: Dayjs | null | undefined) => (value ? value.format('YYYY-MM-DD') : null);

/** A new task's request: empty optional fields left out; the creator is the assignee unless another was picked. */
export function createRequest(
  values: Values,
  fileId: string | null,
  me: string,
): CreateTaskRequest {
  const description = values.description?.trim();
  const dueDate = day(values.dueDate);
  return {
    title: values.title.trim(),
    priority: values.priority,
    ...(description && { description }),
    ...(fileId && { fileId }),
    ...(dueDate && { dueDate }),
    ...(values.assignedToId && values.assignedToId !== me && { assignedToId: values.assignedToId }),
  };
}

/** An edit's request: only what changed; a cleared description or due date is `null`. */
export function updateRequest(task: Task, values: Values): UpdateTaskRequest {
  const description = values.description?.trim() || null;
  const dueDate = day(values.dueDate);
  return {
    ...(values.title.trim() !== task.title && { title: values.title.trim() }),
    ...(description !== task.description && { description }),
    ...(dueDate !== task.dueDate && { dueDate }),
    ...(values.priority !== task.priority && { priority: values.priority }),
    ...(values.assignedToId &&
      values.assignedToId !== task.assignedTo.id && { assignedToId: values.assignedToId }),
  };
}

/** The form's starting values: the task's, or a new one for the caller with medium priority. */
function initialValues(task: Task | null, me: string): Values {
  if (!task)
    return { title: '', description: '', dueDate: null, priority: 'MEDIUM', assignedToId: me };
  return {
    title: task.title,
    description: task.description ?? '',
    dueDate: task.dueDate ? dayjs(task.dueDate) : null,
    priority: task.priority,
    assignedToId: task.assignedTo.id,
  };
}

/** People who can be given a task: active colleagues whose role may work on tasks (D-098; the API re-checks the file). */
function useAssignees(enabled: boolean) {
  const people = useDirectory(enabled);
  return (people.data ?? []).filter((person) =>
    permissionsFor(person.role).includes('complete:task'),
  );
}

function TaskFields({
  canAssign,
  disabled,
}: {
  readonly canAssign: boolean;
  readonly disabled: boolean;
}) {
  const { t } = useTranslation();
  const message = (key: string) => t(key as never);
  const assignees = useAssignees(canAssign);
  const task = useTaskDrawer((state) => state.task);
  // A deactivated assignee is not in the directory (D-124): keep their name on the field.
  const options = assignees.map((person) => ({ value: person.id, label: person.fullName }));
  if (task && !options.some((option) => option.value === task.assignedTo.id)) {
    options.unshift({ value: task.assignedTo.id, label: task.assignedTo.fullName });
  }
  return (
    <>
      <Form.Item
        name="title"
        label={t('tasks.drawer.title')}
        rules={zodRule(CreateTaskSchema.shape.title, message)}
      >
        <Input maxLength={300} disabled={disabled} data-testid="task-title" />
      </Form.Item>
      <Form.Item
        name="description"
        label={t('tasks.drawer.description')}
        rules={zodRule(CreateTaskSchema.shape.description, message)}
      >
        <Input.TextArea
          rows={4}
          maxLength={5000}
          disabled={disabled}
          data-testid="task-description"
        />
      </Form.Item>
      <Flex gap={12} wrap>
        <Form.Item name="dueDate" label={t('tasks.drawer.dueDate')} style={{ flex: '1 1 160px' }}>
          <DatePicker
            format="DD/MM/YYYY"
            style={{ inlineSize: '100%' }}
            disabled={disabled}
            data-testid="task-due"
          />
        </Form.Item>
        <Form.Item name="priority" label={t('tasks.drawer.priority')} style={{ flex: '1 1 160px' }}>
          <Select
            disabled={disabled}
            options={PRIORITIES.map((p) => ({ value: p, label: t(`enums.priority.${p}`) }))}
            data-testid="task-priority"
          />
        </Form.Item>
      </Flex>
      {canAssign ? (
        <Form.Item name="assignedToId" label={t('tasks.drawer.assignee')}>
          <Select
            showSearch={{ optionFilterProp: 'label' }}
            disabled={disabled}
            options={options}
            data-testid="task-assignee"
          />
        </Form.Item>
      ) : null}
    </>
  );
}

/** Where the task belongs: its file as a link, or "personal" (D-098), and who created it. */
function TaskContext({
  task,
  fileId,
}: {
  readonly task: Task | null;
  readonly fileId: string | null;
}) {
  const { t } = useTranslation();
  return (
    <Flex vertical gap={4} style={{ marginBlockEnd: 16 }}>
      {task?.file ? (
        <Typography.Text>
          {t('tasks.drawer.file')}{' '}
          <Link to={`/cases/${task.file.id}`} onClick={closeTaskDrawer}>
            <Ltr>{task.file.fileNumber}</Ltr> <Bdi>{task.file.title}</Bdi>
          </Link>
        </Typography.Text>
      ) : null}
      {!task?.file && !fileId ? (
        <Typography.Text type="secondary">{t('tasks.drawer.personal')}</Typography.Text>
      ) : null}
      {task ? (
        <Typography.Text type="secondary">
          {t('tasks.drawer.createdBy', { name: isolate(task.createdBy.fullName) })}
        </Typography.Text>
      ) : null}
    </Flex>
  );
}

function DrawerActions({
  isNew,
  saving,
  onDelete,
  onSave,
}: {
  readonly isNew: boolean;
  readonly saving: boolean;
  readonly onDelete: () => void;
  readonly onSave: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <Flex gap={8}>
      {isNew ? null : (
        <Button danger onClick={onDelete} data-testid="task-delete">
          {t('tasks.drawer.delete')}
        </Button>
      )}
      <Button type="primary" loading={saving} onClick={onSave} data-testid="task-save">
        {isNew ? t('tasks.drawer.create') : t('common.actions.save')}
      </Button>
    </Flex>
  );
}

/**
 * The task drawer (MVP-77): create or edit title, description, due date, priority and assignee; delete. Giving a task to
 * someone else needs `assign:task`; changing one needs `create:task` (D-098). Read-only on an archived file.
 */
export function TaskDrawer(): React.JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const { applyToForm, notify } = useApiErrorHandler();
  const { open, task, fileId, readOnly } = useTaskDrawer();
  const me = useSession((state) => state.user?.id) ?? '';
  const canWrite = useCan('create:task') && !readOnly;
  const canAssign = useCan('assign:task');
  const [form] = Form.useForm<Values>();
  const [deleting, setDeleting] = useState(false);
  const create = useCreateTask();
  const update = useUpdateTask();
  const remove = useDeleteTask();
  const fields = ['title', 'description', 'dueDate', 'priority', 'assignedToId'];

  const submit = async () => {
    const values = await form.validateFields().catch(() => null);
    if (!values) return;
    try {
      if (task) {
        const body = updateRequest(task, values);
        if (Object.keys(body).length > 0) await update.mutateAsync({ id: task.id, body });
        void message.success(t('tasks.drawer.saved'));
      } else {
        await create.mutateAsync(createRequest(values, fileId, me));
        void message.success(t('tasks.drawer.created'));
      }
      closeTaskDrawer();
    } catch (error) {
      if (!applyToForm(form, error, fields)) notify(error);
    }
  };
  const confirmDelete = () =>
    task &&
    remove.mutate(task.id, {
      onSuccess: () => {
        void message.success(t('tasks.drawer.deleted'));
        closeTaskDrawer();
      },
      onError: notify,
      onSettled: () => setDeleting(false),
    });

  return (
    <Drawer
      open={open}
      onClose={closeTaskDrawer}
      title={task ? t('tasks.drawer.edit') : t('tasks.drawer.new')}
      size="large"
      destroyOnHidden
      data-testid="task-drawer"
      extra={
        canWrite ? (
          <DrawerActions
            isNew={!task}
            saving={create.isPending || update.isPending}
            onDelete={() => setDeleting(true)}
            onSave={() => void submit()}
          />
        ) : null
      }
    >
      <TaskContext task={task} fileId={fileId} />
      {/* Keyed per task: a fresh form with its values (StrictMode-safe, D-121). */}
      <Form
        key={task ? `${task.id}-${task.updatedAt}` : `new-${String(fileId)}`}
        form={form}
        layout="vertical"
        noValidate
        preserve={false}
        initialValues={initialValues(task, me)}
        onFinish={() => void submit()}
      >
        <TaskFields canAssign={canAssign} disabled={!canWrite} />
      </Form>
      <ConfirmModal
        open={deleting}
        danger
        loading={remove.isPending}
        title={t('tasks.drawer.deleteTitle')}
        confirmText={t('common.actions.delete')}
        onConfirm={confirmDelete}
        onCancel={() => setDeleting(false)}
      >
        <Trans
          i18nKey="tasks.drawer.deleteBody"
          values={{ title: task?.title }}
          components={{ title: <bdi /> }}
        />
      </ConfirmModal>
    </Drawer>
  );
}
