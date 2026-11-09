import { taskTemplatesApi } from '@nexlegtiq/shared-api-client';
import { TEMPLATE_ASSIGNEE_ROLES } from '@nexlegtiq/shared-contracts';
import type { CreateTaskTemplateRequest, TaskTemplate } from '@nexlegtiq/shared-contracts';
import { FILE_TYPES } from '@nexlegtiq/shared-types';
import { isErrorCode } from '@nexlegtiq/shared-types';
import {
  ApiErrorAlert,
  ConfirmModal,
  ErrorState,
  isApiError,
  useApiErrorHandler,
} from '@nexlegtiq/shared-ui';
import { isolate } from '@nexlegtiq/shared-utils';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Switch,
  Table,
  Typography,
} from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { apiClient } from '../../auth';

const templates = taskTemplatesApi(apiClient);
const KEY = ['office', 'task-templates'] as const;
/** The "every file type" choice of the form (the API's null). */
const ANY = 'ANY';

interface FormValues {
  readonly name: string;
  readonly fileType: string;
  readonly defaultTitle: string;
  readonly defaultDescription?: string;
  readonly dueDaysAfterOpen?: number | null;
  readonly defaultAssigneeRole: (typeof TEMPLATE_ASSIGNEE_ROLES)[number];
}

const toBody = (values: FormValues): CreateTaskTemplateRequest => ({
  name: values.name,
  fileType:
    values.fileType === ANY ? null : (values.fileType as CreateTaskTemplateRequest['fileType']),
  defaultTitle: values.defaultTitle,
  defaultDescription: values.defaultDescription?.trim() || null,
  dueDaysAfterOpen: values.dueDaysAfterOpen ?? null,
  defaultAssigneeRole: values.defaultAssigneeRole,
});

/** Add or edit one template. */
function TemplateModal({
  editing,
  onClose,
}: {
  readonly editing: TaskTemplate | 'new';
  readonly onClose: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [form] = Form.useForm<FormValues>();
  const save = useMutation({
    mutationFn: (values: FormValues) =>
      editing === 'new'
        ? templates.create(toBody(values))
        : templates.update(editing.id, toBody(values)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: KEY });
      onClose();
    },
  });
  const initial: Partial<FormValues> =
    editing === 'new'
      ? { fileType: ANY, defaultAssigneeRole: 'RESPONSIBLE_LAWYER' }
      : {
          ...editing,
          fileType: editing.fileType ?? ANY,
          defaultDescription: editing.defaultDescription ?? undefined,
        };
  const required = [{ required: true, whitespace: true, message: t('validation.required') }];
  return (
    <Modal
      open
      title={editing === 'new' ? t('settings.templates.add') : t('settings.templates.edit')}
      okText={t('common.actions.save')}
      okButtonProps={{ loading: save.isPending }}
      onOk={() => form.submit()}
      onCancel={onClose}
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={initial}
        onFinish={(values) => save.mutate(values)}
      >
        {save.error ? <ApiErrorAlert error={save.error} /> : null}
        <Form.Item name="name" label={t('settings.templates.name')} rules={required}>
          <Input maxLength={200} data-testid="template-name" />
        </Form.Item>
        <Form.Item name="fileType" label={t('settings.templates.fileType')}>
          <Select
            options={[
              { value: ANY, label: t('settings.templates.anyType') },
              ...FILE_TYPES.map((type) => ({ value: type, label: t(`enums.fileType.${type}`) })),
            ]}
          />
        </Form.Item>
        <Form.Item name="defaultTitle" label={t('settings.templates.taskTitle')} rules={required}>
          <Input maxLength={300} data-testid="template-title" />
        </Form.Item>
        <Form.Item name="defaultDescription" label={t('settings.templates.description')}>
          <Input.TextArea rows={2} maxLength={5000} />
        </Form.Item>
        <Form.Item name="dueDaysAfterOpen" label={t('settings.templates.dueDays')}>
          <InputNumber min={0} max={365} style={{ width: '100%' }} data-testid="template-days" />
        </Form.Item>
        <Form.Item name="defaultAssigneeRole" label={t('settings.templates.assignee')}>
          <Select
            options={TEMPLATE_ASSIGNEE_ROLES.map((role) => ({
              value: role,
              label: t(`enums.fileTeamRole.${role}`),
            }))}
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}

/**
 * Settings → Task templates (MVP-78, D-156): what a new file of each type gets as tasks. Managed by the office manager,
 * like the rest of the settings page.
 */
export function TaskTemplatesSection() {
  const { t } = useTranslation();
  const { notify, referenceOf } = useApiErrorHandler();
  const queryClient = useQueryClient();
  const list = useQuery({ queryKey: KEY, queryFn: ({ signal }) => templates.list(signal) });
  const [editing, setEditing] = useState<TaskTemplate | 'new' | null>(null);
  const [deleting, setDeleting] = useState<TaskTemplate | null>(null);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: KEY });
  const toggle = useMutation({
    mutationFn: (row: TaskTemplate) => templates.update(row.id, { isActive: !row.isActive }),
    onSuccess: refresh,
    onError: notify,
  });
  const remove = useMutation({
    mutationFn: (id: string) => templates.remove(id),
    onSuccess: refresh,
    onError: notify,
    onSettled: () => setDeleting(null),
  });
  return (
    <Card
      title={
        <Typography.Title level={2} style={{ margin: 0 }}>
          {t('settings.templates.title')}
        </Typography.Title>
      }
      extra={
        <Button onClick={() => setEditing('new')} data-testid="template-add">
          {t('settings.templates.add')}
        </Button>
      }
      data-testid="settings-templates"
    >
      <Typography.Paragraph type="secondary">{t('settings.templates.hint')}</Typography.Paragraph>
      {list.isError ? (
        <ErrorState
          code={
            isApiError(list.error) && isErrorCode(list.error.code) ? list.error.code : undefined
          }
          requestId={referenceOf(list.error)}
          onRetry={() => void list.refetch()}
        />
      ) : null}
      <Table<TaskTemplate>
        rowKey="id"
        size="small"
        loading={list.isPending}
        pagination={false}
        scroll={{ x: true }}
        dataSource={list.data ?? []}
        columns={[
          {
            key: 'name',
            title: t('settings.templates.name'),
            render: (_, row) => <bdi>{row.name}</bdi>,
          },
          {
            key: 'type',
            title: t('settings.templates.fileType'),
            render: (_, row) =>
              row.fileType ? t(`enums.fileType.${row.fileType}`) : t('settings.templates.anyType'),
          },
          {
            key: 'title',
            title: t('settings.templates.taskTitle'),
            render: (_, row) => <bdi>{row.defaultTitle}</bdi>,
          },
          {
            key: 'days',
            title: t('settings.templates.dueDays'),
            render: (_, row) => row.dueDaysAfterOpen ?? '—',
          },
          {
            key: 'assignee',
            title: t('settings.templates.assignee'),
            render: (_, row) => t(`enums.fileTeamRole.${row.defaultAssigneeRole}`),
          },
          {
            key: 'active',
            title: t('settings.templates.active'),
            render: (_, row) => (
              <Switch
                checked={row.isActive}
                aria-label={t('settings.templates.activeFor', { name: isolate(row.name) })}
                onChange={() => toggle.mutate(row)}
              />
            ),
          },
          {
            key: 'actions',
            title: t('settings.templates.actions'),
            render: (_, row) => (
              <>
                <Button size="small" type="link" onClick={() => setEditing(row)}>
                  {t('common.actions.edit')}
                </Button>
                <Button size="small" type="link" danger onClick={() => setDeleting(row)}>
                  {t('common.actions.delete')}
                </Button>
              </>
            ),
          },
        ]}
      />
      {editing ? <TemplateModal editing={editing} onClose={() => setEditing(null)} /> : null}
      <ConfirmModal
        open={deleting !== null}
        danger
        title={t('settings.templates.deleteTitle')}
        confirmText={t('common.actions.delete')}
        loading={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
        onCancel={() => setDeleting(null)}
      >
        {t('settings.templates.deleteBody')}
      </ConfirmModal>
    </Card>
  );
}
