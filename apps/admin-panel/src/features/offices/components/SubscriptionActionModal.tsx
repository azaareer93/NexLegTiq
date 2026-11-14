import { SUBSCRIPTION_ACTIONS, SubscriptionActionSchema } from '@nexlegtiq/shared-contracts';
import { Bdi, ApiErrorAlert, useApiErrorHandler } from '@nexlegtiq/shared-ui';
import { App, DatePicker, Form, Input, Modal, Radio, Select } from 'antd';
import type { Dayjs } from 'dayjs';
import { useTranslation } from 'react-i18next';

import { parseForm } from '../../auth/forms';
import { usePlansList } from '../../plans/hooks';
import { useSubscriptionAction } from '../hooks';

interface Props {
  readonly officeId: string;
  readonly onClose: () => void;
}

interface Values {
  action: (typeof SUBSCRIPTION_ACTIONS)[number];
  planId?: string;
  until?: Dayjs;
  reason?: string;
}

const FIELDS = ['planId', 'until', 'reason'];

/** One action on the office's current subscription (D-173): change plan, extend the period or set a trial end. */
export function SubscriptionActionModal({ officeId, onClose }: Props): React.JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const { translateKey, applyToForm } = useApiErrorHandler();
  const [form] = Form.useForm<Values>();
  const action = Form.useWatch('action', form) ?? 'EXTEND_PERIOD';
  const mutation = useSubscriptionAction(officeId);
  const plans = usePlansList();

  const submit = async (): Promise<void> => {
    const v = form.getFieldsValue(true) as Values;
    const parsed = parseForm(
      SubscriptionActionSchema,
      {
        action: v.action,
        planId: v.action === 'CHANGE_PLAN' ? v.planId : undefined,
        until: v.action === 'CHANGE_PLAN' ? undefined : v.until?.format('YYYY-MM-DD'),
        reason: v.reason?.trim() || undefined,
      },
      form,
      translateKey,
    );
    if (!parsed) return;
    try {
      await mutation.mutateAsync(parsed);
      void message.success(t('admin.offices.subscriptionAction.success'));
      onClose();
    } catch (error) {
      applyToForm(form, error, FIELDS);
    }
  };

  return (
    <Modal
      open
      title={t('admin.offices.subscriptionAction.title')}
      okText={t('common.actions.save')}
      cancelText={t('common.actions.cancel')}
      okButtonProps={{ 'data-testid': 'subscription-confirm' }}
      confirmLoading={mutation.isPending}
      onOk={() => void submit()}
      onCancel={onClose}
    >
      <p>{t('admin.offices.subscriptionAction.hint')}</p>
      <Form form={form} layout="vertical" noValidate initialValues={{ action: 'EXTEND_PERIOD' }}>
        <Form.Item name="action" label={t('admin.offices.subscriptionAction.action')}>
          <Radio.Group data-testid="subscription-action">
            {SUBSCRIPTION_ACTIONS.map((a) => (
              <Radio key={a} value={a} data-testid={`subscription-action-${a}`}>
                {t(`admin.offices.subscriptionAction.actions.${a}`)}
              </Radio>
            ))}
          </Radio.Group>
        </Form.Item>
        {action === 'CHANGE_PLAN' ? (
          <Form.Item
            name="planId"
            label={t('admin.offices.subscriptionAction.plan')}
            rules={[{ required: true, message: translateKey('validation.required') }]}
          >
            <Select
              loading={plans.isLoading}
              data-testid="subscription-plan"
              options={(plans.data ?? [])
                .filter((p) => p.isActive)
                .map((p) => ({
                  value: p.id,
                  label: (
                    <Bdi>
                      {p.name} ({p.code})
                    </Bdi>
                  ),
                }))}
            />
          </Form.Item>
        ) : (
          <Form.Item
            name="until"
            label={t(
              action === 'SET_TRIAL'
                ? 'admin.offices.subscriptionAction.trialUntil'
                : 'admin.offices.subscriptionAction.periodUntil',
            )}
            extra={t('admin.offices.subscriptionAction.untilHint')}
            rules={[{ required: true, message: translateKey('validation.required') }]}
          >
            <DatePicker format="DD/MM/YYYY" data-testid="subscription-until" />
          </Form.Item>
        )}
        <Form.Item name="reason" label={t('admin.offices.modal.reason')}>
          <Input.TextArea rows={3} maxLength={500} showCount data-testid="subscription-reason" />
        </Form.Item>
      </Form>
      {mutation.isError ? <ApiErrorAlert error={mutation.error} fields={FIELDS} /> : null}
    </Modal>
  );
}
