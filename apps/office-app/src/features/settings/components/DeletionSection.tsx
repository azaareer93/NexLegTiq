import { DeleteOutlined } from '@ant-design/icons';
import { exportsApi } from '@nexlegtiq/shared-api-client';
import {
  OFFICE_DELETION_GRACE_DAYS,
  RequestOfficeDeletionSchema,
} from '@nexlegtiq/shared-contracts';
import type { RequestOfficeDeletionRequest } from '@nexlegtiq/shared-contracts';
import {
  ApiErrorAlert,
  isApiError,
  useApiErrorHandler,
  useCan,
  useFormat,
} from '@nexlegtiq/shared-ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Card, Form, Input, Modal, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { apiClient, subscriptionKey } from '../../auth';
import { parseForm } from '../../auth/forms';

const api = exportsApi(apiClient);
const deletionKey = ['office', 'deletion'] as const;
const FIELDS = ['password', 'mfaCode'];

/** Status and both writes; a change reloads the subscription, which drives the read-only banner. */
function useDeletion(enabled: boolean) {
  const queryClient = useQueryClient();
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: deletionKey });
    void queryClient.invalidateQueries({ queryKey: subscriptionKey });
  };
  return {
    status: useQuery({
      queryKey: deletionKey,
      queryFn: ({ signal }) => api.deletion(signal),
      enabled,
    }),
    request: useMutation({
      mutationFn: (body: RequestOfficeDeletionRequest) => api.requestDeletion(body),
      onSuccess: refresh,
    }),
    cancel: useMutation({ mutationFn: () => api.cancelDeletion(), onSuccess: refresh }),
  };
}

function RequestModal({
  request,
  onClose,
}: {
  readonly request: ReturnType<typeof useDeletion>['request'];
  readonly onClose: () => void;
}) {
  const { t } = useTranslation();
  const { translateKey, applyToForm } = useApiErrorHandler();
  const [form] = Form.useForm<{ password?: string; mfaCode?: string }>();
  // The code field appears when the server asks for it (MFA on), so users without MFA never see it.
  const [needsCode, setNeedsCode] = useState(false);
  // That first error is applied once the field exists: setting it on a field not yet rendered would be lost.
  const [codeError, setCodeError] = useState<unknown>(null);
  useEffect(() => {
    if (!needsCode || codeError === null) return;
    applyToForm(form, codeError, FIELDS);
    setCodeError(null);
  }, [needsCode, codeError, applyToForm, form]);

  const submit = () => {
    const values = form.getFieldsValue();
    const body = parseForm(
      RequestOfficeDeletionSchema,
      { password: values.password ?? '', ...(values.mfaCode ? { mfaCode: values.mfaCode } : {}) },
      form,
      translateKey,
    );
    if (!body) return;
    request.mutate(body, {
      onSuccess: onClose,
      onError: (error) => {
        if (!needsCode && isApiError(error) && error.details?.some((d) => d.field === 'mfaCode')) {
          setNeedsCode(true);
          setCodeError(error);
          return;
        }
        applyToForm(form, error, FIELDS);
      },
    });
  };

  return (
    <Modal
      open
      title={t('settings.deletion.modal.title')}
      okText={t('settings.deletion.modal.ok')}
      cancelText={t('common.actions.close')}
      okButtonProps={{ danger: true, 'data-testid': 'deletion-confirm' }}
      cancelButtonProps={{ 'data-testid': 'deletion-dismiss' }}
      confirmLoading={request.isPending}
      onOk={submit}
      onCancel={onClose}
    >
      <Typography.Paragraph>
        {t('settings.deletion.modal.intro', { days: OFFICE_DELETION_GRACE_DAYS })}
      </Typography.Paragraph>
      <Form form={form} layout="vertical" noValidate requiredMark={false} onFinish={submit}>
        <ApiErrorAlert error={request.error} fields={FIELDS} />
        <Form.Item name="password" label={t('settings.deletion.modal.password')}>
          <Input.Password
            dir="ltr"
            autoComplete="current-password"
            data-testid="deletion-password"
          />
        </Form.Item>
        {needsCode ? (
          <Form.Item name="mfaCode" label={t('settings.deletion.modal.code')}>
            <Input
              dir="ltr"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              data-testid="deletion-code"
            />
          </Form.Item>
        ) : null}
      </Form>
    </Modal>
  );
}

/**
 * Settings → Delete the office (MVP-152, D-251), office managers only: what happens, the request (password again), and
 * while it is scheduled the date and a cancel button.
 */
export function DeletionSection(): React.JSX.Element | null {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const format = useFormat();
  const mayManage = useCan('manage:office');
  const { status, request, cancel } = useDeletion(mayManage);
  const [asking, setAsking] = useState(false);
  if (!mayManage || !status.data) return null;
  const scheduledFor = status.data.scheduledFor;

  return (
    <Card title={t('settings.deletion.title')} data-testid="settings-deletion">
      {scheduledFor ? (
        <>
          <Alert
            type="error"
            showIcon
            title={t('settings.deletion.scheduled', { date: format.dateTime(scheduledFor) })}
            data-testid="deletion-scheduled"
          />
          <Button
            style={{ marginBlockStart: 16 }}
            loading={cancel.isPending}
            onClick={() =>
              cancel.mutate(undefined, {
                onSuccess: () => void message.success(t('settings.deletion.cancelled')),
              })
            }
            data-testid="deletion-cancel"
          >
            {t('settings.deletion.cancel')}
          </Button>
          {cancel.isError ? <ApiErrorAlert error={cancel.error} /> : null}
        </>
      ) : (
        <>
          <Typography.Paragraph type="secondary">
            {t('settings.deletion.hint', { days: OFFICE_DELETION_GRACE_DAYS })}
          </Typography.Paragraph>
          <ul data-testid="deletion-consequences">
            <li>{t('settings.deletion.consequences.readOnly')}</li>
            <li>
              {t('settings.deletion.consequences.purge', { days: OFFICE_DELETION_GRACE_DAYS })}
            </li>
            <li>{t('settings.deletion.consequences.kept')}</li>
          </ul>
          <Button
            danger
            icon={<DeleteOutlined />}
            onClick={() => setAsking(true)}
            data-testid="deletion-request"
          >
            {t('settings.deletion.request')}
          </Button>
        </>
      )}
      {asking ? <RequestModal request={request} onClose={() => setAsking(false)} /> : null}
    </Card>
  );
}
