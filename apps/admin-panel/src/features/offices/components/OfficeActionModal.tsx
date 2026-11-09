import { ReactivateOfficeSchema, SuspendOfficeSchema } from '@nexlegtiq/shared-contracts';
import { ApiErrorAlert, useApiErrorHandler } from '@nexlegtiq/shared-ui';
import { App, Form, Input, Modal } from 'antd';
import { useTranslation } from 'react-i18next';

import { parseForm, zodRule } from '../../auth/forms';
import { useOfficeAction } from '../hooks';

interface Props {
  readonly officeId: string;
  readonly kind: 'suspend' | 'reactivate';
  readonly onClose: () => void;
}

/** Suspend (reason required) or reactivate (reason optional), validated with the contract. */
export function OfficeActionModal({ officeId, kind, onClose }: Props): React.JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const { translateKey, applyToForm } = useApiErrorHandler();
  const [form] = Form.useForm<{ reason?: string }>();
  const action = useOfficeAction(officeId, kind);
  const schema = kind === 'suspend' ? SuspendOfficeSchema : ReactivateOfficeSchema;

  const submit = async (): Promise<void> => {
    const parsed = parseForm(
      schema,
      { reason: (form.getFieldValue('reason') as string | undefined)?.trim() || undefined },
      form,
      translateKey,
    );
    if (!parsed) return;
    try {
      await action.mutateAsync(parsed.reason ?? '');
      void message.success(t(`admin.offices.modal.${kind}.success`));
      onClose();
    } catch (error) {
      applyToForm(form, error, ['reason']);
    }
  };

  return (
    <Modal
      open
      title={t(`admin.offices.modal.${kind}.title`)}
      okText={t(`admin.offices.modal.${kind}.ok`)}
      cancelText={t('common.actions.cancel')}
      okButtonProps={{ danger: kind === 'suspend', 'data-testid': 'office-action-confirm' }}
      cancelButtonProps={{ 'data-testid': 'office-action-cancel' }}
      confirmLoading={action.isPending}
      onOk={() => void submit()}
      onCancel={onClose}
    >
      <p>{t(`admin.offices.modal.${kind}.intro`)}</p>
      <Form form={form} layout="vertical" noValidate>
        <Form.Item
          name="reason"
          label={t('admin.offices.modal.reason')}
          rules={zodRule(schema.shape.reason, translateKey)}
        >
          <Input.TextArea rows={4} maxLength={500} showCount data-testid="office-action-reason" />
        </Form.Item>
      </Form>
      {action.isError ? <ApiErrorAlert error={action.error} fields={['reason']} /> : null}
    </Modal>
  );
}
