import type { Case } from '@nexlegtiq/shared-contracts';
import { ApiErrorAlert, ConfirmModal, useApiErrorHandler } from '@nexlegtiq/shared-ui';
import { isolate } from '@nexlegtiq/shared-utils';
import { Alert, App, Form, Input, Modal, Select } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useDirectory, useFileLifecycle } from '../api/use-cases';

export type LifecycleDialog = 'close' | 'reopen' | 'archive' | 'reassign';

const LAWYER_ROLES = new Set(['OFFICE_MANAGER', 'SENIOR_LAWYER', 'LAWYER']);

/** Open tasks reported by a refused close (BIZ-003, D-153), or null for any other answer. */
function openTasksOf(error: unknown): string | null {
  const detail = (
    error as { code?: string; details?: { params?: Record<string, string> }[] } | null
  )?.details?.[0];
  return (error as { code?: string } | null)?.code === 'BIZ-003'
    ? (detail?.params?.openTasks ?? null)
    : null;
}

/** Close: a reason; open tasks ask once more, with the reason for closing anyway (BIZ-003). */
function CloseDialog({ file, onClose }: { readonly file: Case; readonly onClose: () => void }) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const { close } = useFileLifecycle(file.id);
  const [openTasks, setOpenTasks] = useState<string | null>(null);
  const [form] = Form.useForm<{ reason?: string; forceReason?: string }>();
  const submit = (values: { reason?: string; forceReason?: string }) =>
    close.mutate(
      { reason: values.reason, force: openTasks !== null, forceReason: values.forceReason },
      {
        onSuccess: () => {
          void message.success(t('cases.file.lifecycle.closed'));
          onClose();
        },
        onError: (error) => setOpenTasks(openTasksOf(error)),
      },
    );
  const otherError = close.error && openTasksOf(close.error) === null ? close.error : null;
  return (
    <Modal
      open
      title={t('cases.file.lifecycle.closeTitle')}
      okText={openTasks ? t('cases.file.lifecycle.closeAnyway') : t('cases.file.actions.close')}
      okButtonProps={
        {
          danger: openTasks !== null,
          loading: close.isPending,
          'data-testid': 'close-confirm',
        } as never
      }
      onOk={() => form.submit()}
      onCancel={onClose}
      data-testid="close-case-dialog"
    >
      <Form form={form} layout="vertical" onFinish={submit}>
        {otherError ? <ApiErrorAlert error={otherError} /> : null}
        <Form.Item name="reason" label={t('cases.file.lifecycle.reason')}>
          <Input.TextArea rows={2} maxLength={1000} data-testid="close-reason" />
        </Form.Item>
        {openTasks ? (
          <>
            <Alert
              type="warning"
              showIcon
              message={t('cases.file.lifecycle.openTasks', { count: isolate(openTasks) })}
            />
            <Form.Item
              name="forceReason"
              label={t('cases.file.lifecycle.forceReason')}
              rules={[{ required: true, whitespace: true, message: t('validation.required') }]}
            >
              <Input.TextArea rows={2} maxLength={1000} data-testid="close-force-reason" />
            </Form.Item>
          </>
        ) : null}
      </Form>
    </Modal>
  );
}

/** Reassign: a new responsible lawyer from the people directory (D-123) and an optional note. */
function ReassignDialog({ file, onClose }: { readonly file: Case; readonly onClose: () => void }) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const { reassign } = useFileLifecycle(file.id);
  const directory = useDirectory();
  const [form] = Form.useForm<{ newResponsibleLawyerId: string; note?: string }>();
  const lawyers = (directory.data ?? []).filter(
    (person) => LAWYER_ROLES.has(person.role) && person.id !== file.responsibleLawyer.id,
  );
  return (
    <Modal
      open
      title={t('cases.file.lifecycle.reassignTitle')}
      okText={t('cases.file.actions.reassign')}
      okButtonProps={{ loading: reassign.isPending, 'data-testid': 'reassign-confirm' } as never}
      onOk={() => form.submit()}
      onCancel={onClose}
      data-testid="reassign-dialog"
    >
      <Form
        form={form}
        layout="vertical"
        onFinish={(values) =>
          reassign.mutate(values, {
            onSuccess: () => {
              void message.success(t('cases.file.lifecycle.reassigned'));
              onClose();
            },
          })
        }
      >
        {reassign.error ? <ApiErrorAlert error={reassign.error} /> : null}
        <Form.Item
          name="newResponsibleLawyerId"
          label={t('cases.file.lifecycle.newLawyer')}
          rules={[{ required: true, message: t('validation.required') }]}
        >
          <Select
            showSearch
            optionFilterProp="label"
            loading={directory.isPending}
            options={lawyers.map((person) => ({ value: person.id, label: person.fullName }))}
            data-testid="reassign-lawyer"
          />
        </Form.Item>
        <Form.Item name="note" label={t('cases.file.lifecycle.note')}>
          <Input.TextArea rows={2} maxLength={1000} data-testid="reassign-note" />
        </Form.Item>
      </Form>
    </Modal>
  );
}

/** The file header's lifecycle dialogs (MVP-64, D-153); the API re-checks every right. */
export function LifecycleDialogs({
  file,
  dialog,
  onClose,
}: {
  readonly file: Case;
  readonly dialog: LifecycleDialog | null;
  readonly onClose: () => void;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const { notify } = useApiErrorHandler();
  const { reopen, archive } = useFileLifecycle(file.id);
  const run = (mutation: typeof reopen, done: string) =>
    mutation.mutate(undefined, {
      onSuccess: () => {
        void message.success(t(done as never));
        onClose();
      },
      onError: (error) => {
        onClose();
        notify(error);
      },
    });
  if (dialog === 'close') return <CloseDialog file={file} onClose={onClose} />;
  if (dialog === 'reassign') return <ReassignDialog file={file} onClose={onClose} />;
  return (
    <>
      <ConfirmModal
        open={dialog === 'reopen'}
        title={t('cases.file.lifecycle.reopenTitle')}
        confirmText={t('cases.file.actions.reopen')}
        loading={reopen.isPending}
        onConfirm={() => run(reopen, 'cases.file.lifecycle.reopened')}
        onCancel={onClose}
      >
        {t('cases.file.lifecycle.reopenBody')}
      </ConfirmModal>
      <ConfirmModal
        open={dialog === 'archive'}
        danger
        title={t('cases.file.lifecycle.archiveTitle')}
        confirmText={t('cases.file.actions.archive')}
        loading={archive.isPending}
        onConfirm={() => run(archive, 'cases.file.lifecycle.archivedDone')}
        onCancel={onClose}
      >
        {t('cases.file.lifecycle.archiveBody')}
      </ConfirmModal>
    </>
  );
}
