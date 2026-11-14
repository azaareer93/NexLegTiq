import { RecordPaymentSchema, VoidPaymentSchema } from '@nexlegtiq/shared-contracts';
import type { AdminPayment } from '@nexlegtiq/shared-contracts';
import { PLATFORM_PAYMENT_METHODS } from '@nexlegtiq/shared-types';
import { ApiErrorAlert, Ltr, useApiErrorHandler } from '@nexlegtiq/shared-ui';
import { App, Checkbox, DatePicker, Form, Input, Modal, Select } from 'antd';
import dayjs from 'dayjs';
import type { Dayjs } from 'dayjs';
import { useTranslation } from 'react-i18next';

import { parseForm, zodRule } from '../../auth/forms';
import { usePaymentMutations } from '../hooks';

interface RecordValues {
  amount?: string;
  currency?: string;
  method?: string;
  reference?: string;
  paidAt?: Dayjs;
  emailOffice?: boolean;
}

const RECORD_FIELDS = ['amount', 'currency', 'method', 'reference', 'paidAt', 'emailOffice'];

/** Record a cash/bank payment (D-174); the receipt is numbered by the server and emailed when asked. */
export function RecordPaymentModal({
  officeId,
  currency,
  onClose,
}: {
  readonly officeId: string;
  readonly currency: string;
  readonly onClose: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const { translateKey, applyToForm } = useApiErrorHandler();
  const [form] = Form.useForm<RecordValues>();
  const { record } = usePaymentMutations(officeId);

  const submit = async (): Promise<void> => {
    const v = form.getFieldsValue(true) as RecordValues;
    const parsed = parseForm(
      RecordPaymentSchema,
      {
        amount: v.amount?.trim(),
        currency: v.currency,
        method: v.method,
        reference: v.reference?.trim() || null,
        paidAt: v.paidAt?.format('YYYY-MM-DD'),
        emailOffice: v.emailOffice === true,
      },
      form,
      translateKey,
    );
    if (!parsed) return;
    try {
      await record.mutateAsync(parsed);
      void message.success(t('admin.offices.payments.modal.success'));
      onClose();
    } catch (error) {
      applyToForm(form, error, RECORD_FIELDS);
    }
  };

  const required = { required: true, message: translateKey('validation.required') };
  return (
    <Modal
      open
      title={t('admin.offices.payments.modal.title')}
      okText={t('common.actions.save')}
      cancelText={t('common.actions.cancel')}
      okButtonProps={{ 'data-testid': 'payment-confirm' }}
      confirmLoading={record.isPending}
      onOk={() => void submit()}
      onCancel={onClose}
    >
      <p>{t('admin.offices.payments.hint')}</p>
      <Form
        form={form}
        layout="vertical"
        noValidate
        initialValues={{ currency, method: 'BANK_TRANSFER', paidAt: dayjs(), emailOffice: true }}
      >
        <Form.Item
          name="amount"
          label={t('admin.offices.payments.modal.amount')}
          rules={[required]}
        >
          <Input dir="ltr" inputMode="decimal" data-testid="payment-amount" />
        </Form.Item>
        <Form.Item
          name="currency"
          label={t('admin.offices.payments.modal.currency')}
          rules={[required]}
        >
          <Input dir="ltr" maxLength={3} data-testid="payment-currency" />
        </Form.Item>
        <Form.Item name="method" label={t('admin.offices.payments.modal.method')}>
          <Select
            data-testid="payment-method"
            options={PLATFORM_PAYMENT_METHODS.map((m) => ({
              value: m,
              label: t(`enums.platformPaymentMethod.${m}`),
            }))}
          />
        </Form.Item>
        <Form.Item name="reference" label={t('admin.offices.payments.modal.reference')}>
          <Input dir="ltr" maxLength={100} data-testid="payment-reference" />
        </Form.Item>
        <Form.Item
          name="paidAt"
          label={t('admin.offices.payments.modal.paidAt')}
          rules={[required]}
        >
          <DatePicker format="DD/MM/YYYY" style={{ width: '100%' }} data-testid="payment-paid-at" />
        </Form.Item>
        <Form.Item name="emailOffice" valuePropName="checked">
          <Checkbox data-testid="payment-email">
            {t('admin.offices.payments.modal.emailOffice')}
          </Checkbox>
        </Form.Item>
      </Form>
      {record.isError ? <ApiErrorAlert error={record.error} fields={RECORD_FIELDS} /> : null}
    </Modal>
  );
}

export function VoidPaymentModal({
  officeId,
  payment,
  onClose,
}: {
  readonly officeId: string;
  readonly payment: AdminPayment;
  readonly onClose: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const { translateKey, applyToForm } = useApiErrorHandler();
  const [form] = Form.useForm<{ reason?: string }>();
  const { void: voiding } = usePaymentMutations(officeId);

  const submit = async (): Promise<void> => {
    const parsed = parseForm(
      VoidPaymentSchema,
      { reason: (form.getFieldValue('reason') as string | undefined) ?? '' },
      form,
      translateKey,
    );
    if (!parsed) return;
    try {
      await voiding.mutateAsync({ id: payment.id, reason: parsed.reason });
      void message.success(t('admin.offices.payments.void.success'));
      onClose();
    } catch (error) {
      applyToForm(form, error, ['reason']);
    }
  };

  return (
    <Modal
      open
      title={
        <>
          {t('admin.offices.payments.void.title')} <Ltr>{payment.receiptNumber}</Ltr>
        </>
      }
      okText={t('admin.offices.payments.actions.void')}
      cancelText={t('common.actions.cancel')}
      okButtonProps={{ danger: true, 'data-testid': 'payment-void-confirm' }}
      confirmLoading={voiding.isPending}
      onOk={() => void submit()}
      onCancel={onClose}
    >
      <p>{t('admin.offices.payments.void.hint')}</p>
      <Form form={form} layout="vertical" noValidate>
        <Form.Item
          name="reason"
          label={t('admin.offices.payments.void.reason')}
          rules={zodRule(VoidPaymentSchema.shape.reason, translateKey)}
        >
          <Input.TextArea rows={3} maxLength={500} showCount data-testid="payment-void-reason" />
        </Form.Item>
      </Form>
      {voiding.isError ? <ApiErrorAlert error={voiding.error} fields={['reason']} /> : null}
    </Modal>
  );
}
