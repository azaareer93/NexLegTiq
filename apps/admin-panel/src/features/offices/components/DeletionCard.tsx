import { adminOfficesApi } from '@nexlegtiq/shared-api-client';
import {
  AdminCancelDeletionSchema,
  AdminRescheduleDeletionSchema,
} from '@nexlegtiq/shared-contracts';
import type { AdminOfficeDetail } from '@nexlegtiq/shared-contracts';
import { ApiErrorAlert, Bdi, useApiErrorHandler, useFormat } from '@nexlegtiq/shared-ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, DatePicker, Flex, Form, Input, Modal } from 'antd';
import dayjs from 'dayjs';
import type { Dayjs } from 'dayjs';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { parseForm } from '../../auth/forms';
import { apiClient } from '../../auth/session';
import { officeKeys } from '../keys';

const offices = adminOfficesApi(apiClient);
type Kind = 'cancel' | 'reschedule';
interface Values {
  reason?: string;
  scheduledFor?: Dayjs;
}

/** Cancel (reason) or bring the date forward (date + reason naming the office's written request), D-251. */
function DeletionModal({
  office,
  kind,
  onClose,
}: {
  readonly office: AdminOfficeDetail;
  readonly kind: Kind;
  readonly onClose: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const { translateKey, applyToForm } = useApiErrorHandler();
  const queryClient = useQueryClient();
  const [form] = Form.useForm<Values>();
  const action = useMutation({
    mutationFn: (v: { reason: string; scheduledFor?: string }) =>
      kind === 'cancel'
        ? offices.cancelDeletion(office.id, { reason: v.reason })
        : offices.rescheduleDeletion(office.id, {
            reason: v.reason,
            scheduledFor: v.scheduledFor ?? '',
          }),
    gcTime: 0,
    onSuccess: (detail) => queryClient.setQueryData(officeKeys.detail(office.id), detail),
  });
  const fields = kind === 'cancel' ? ['reason'] : ['scheduledFor', 'reason'];

  const submit = async (): Promise<void> => {
    const v = form.getFieldsValue(true) as Values;
    const reason = v.reason?.trim() ?? '';
    const parsed =
      kind === 'cancel'
        ? parseForm(AdminCancelDeletionSchema, { reason }, form, translateKey)
        : parseForm(
            AdminRescheduleDeletionSchema,
            { reason, scheduledFor: v.scheduledFor?.toISOString() },
            form,
            translateKey,
          );
    if (!parsed) return;
    try {
      await action.mutateAsync(parsed);
      void message.success(t(`admin.offices.deletion.${kind}.success`));
      onClose();
    } catch (error) {
      applyToForm(form, error, fields);
    }
  };

  return (
    <Modal
      open
      title={t(`admin.offices.deletion.${kind}.title`)}
      okText={t(`admin.offices.deletion.${kind}.ok`)}
      cancelText={t('common.actions.close')}
      okButtonProps={{ danger: kind === 'reschedule', 'data-testid': 'deletion-action-confirm' }}
      confirmLoading={action.isPending}
      onOk={() => void submit()}
      onCancel={onClose}
    >
      <p>{t(`admin.offices.deletion.${kind}.intro`)}</p>
      <Form form={form} layout="vertical" noValidate>
        {kind === 'reschedule' ? (
          <Form.Item name="scheduledFor" label={t('admin.offices.deletion.reschedule.date')}>
            <DatePicker
              showTime
              format="DD/MM/YYYY HH:mm"
              style={{ width: '100%' }}
              disabledDate={(d) =>
                d.isBefore(dayjs(), 'day') || !d.isBefore(dayjs(office.deletion?.scheduledFor))
              }
              data-testid="deletion-date"
            />
          </Form.Item>
        ) : null}
        <Form.Item name="reason" label={t(`admin.offices.deletion.${kind}.reason`)}>
          <Input.TextArea rows={4} maxLength={500} showCount data-testid="deletion-reason" />
        </Form.Item>
      </Form>
      {action.isError ? <ApiErrorAlert error={action.error} fields={fields} /> : null}
    </Modal>
  );
}

/** The office's deletion (D-251): when it was asked and runs, or when it was purged, with the platform's two actions. */
export function DeletionCard({ office }: { readonly office: AdminOfficeDetail }) {
  const { t } = useTranslation();
  const format = useFormat();
  const [kind, setKind] = useState<Kind | null>(null);
  const deletion = office.deletion;
  if (!deletion) return null;
  if (deletion.purgedAt) {
    return (
      <Alert
        type="error"
        showIcon
        style={{ marginBlockEnd: 16 }}
        data-testid="office-purged"
        title={
          <>
            {t('admin.offices.deletion.purged')} <Bdi>{format.dateTime(deletion.purgedAt)}</Bdi>
          </>
        }
      />
    );
  }
  if (!deletion.scheduledFor) return null;
  return (
    <>
      <Alert
        type="warning"
        showIcon
        style={{ marginBlockEnd: 16 }}
        data-testid="office-deletion"
        title={
          <>
            {t('admin.offices.deletion.scheduled')}{' '}
            <Bdi>{format.dateTime(deletion.scheduledFor)}</Bdi>
          </>
        }
        description={
          deletion.requestedAt ? (
            <>
              {t('admin.offices.deletion.requested')}{' '}
              <Bdi>{format.dateTime(deletion.requestedAt)}</Bdi>
            </>
          ) : null
        }
        action={
          <Flex vertical gap={8}>
            <Button size="small" onClick={() => setKind('cancel')} data-testid="deletion-cancel">
              {t('admin.offices.deletion.cancel.ok')}
            </Button>
            <Button
              size="small"
              danger
              onClick={() => setKind('reschedule')}
              data-testid="deletion-reschedule"
            >
              {t('admin.offices.deletion.reschedule.ok')}
            </Button>
          </Flex>
        }
      />
      {kind ? <DeletionModal office={office} kind={kind} onClose={() => setKind(null)} /> : null}
    </>
  );
}
