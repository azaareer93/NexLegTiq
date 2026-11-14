import { CreatePlanSchema, PLAN_FEATURES, UpdatePlanSchema } from '@nexlegtiq/shared-contracts';
import type { AdminPlan } from '@nexlegtiq/shared-contracts';
import { PLAN_MARKETS } from '@nexlegtiq/shared-types';
import { ApiErrorAlert, useApiErrorHandler } from '@nexlegtiq/shared-ui';
import { App, Checkbox, Form, Input, InputNumber, Modal, Select } from 'antd';
import { useTranslation } from 'react-i18next';

import { parseForm } from '../../auth/forms';
import { usePlanMutations } from '../hooks';

interface Props {
  /** The plan to edit; absent = create. */
  readonly plan?: AdminPlan;
  readonly onClose: () => void;
}

interface Values {
  code?: string;
  name?: string;
  market?: string;
  priceMonthly?: string;
  currency?: string;
  maxUsers?: number | null;
  aiQuotaMonthly?: number | null;
  ocrPagesMonthly?: number | null;
  storageQuotaMb?: number | null;
  trialDays?: number | null;
  sortOrder?: number | null;
  isActive?: boolean;
  features?: Record<string, boolean>;
}

const FIELDS = [
  'code',
  'name',
  'market',
  'priceMonthly',
  'currency',
  'maxUsers',
  'aiQuotaMonthly',
  'ocrPagesMonthly',
  'storageQuotaMb',
  'trialDays',
  'sortOrder',
  'features',
];

/** The form values as a request body; flags this form does not offer (e.g. customPricing) stay as the plan has them. */
function buildBody(v: Values, plan?: AdminPlan) {
  return {
    name: v.name?.trim(),
    market: v.market,
    priceMonthly: v.priceMonthly,
    currency: v.currency?.trim().toUpperCase(),
    maxUsers: v.maxUsers ?? null,
    aiQuotaMonthly: v.aiQuotaMonthly ?? null,
    ocrPagesMonthly: v.ocrPagesMonthly,
    storageQuotaMb: v.storageQuotaMb,
    trialDays: v.trialDays ?? null,
    sortOrder: v.sortOrder,
    isActive: v.isActive,
    features: {
      ...plan?.features,
      ...Object.fromEntries(PLAN_FEATURES.map((f) => [f, v.features?.[f] === true])),
    },
  };
}

/** Create a plan, or edit one (the code is fixed once created). An empty limit that may be unlimited is sent as null. */
export function PlanModal({ plan, onClose }: Props): React.JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const { translateKey, applyToForm } = useApiErrorHandler();
  const [form] = Form.useForm<Values>();
  const { create, update } = usePlanMutations();
  const mutation = plan ? update : create;

  const submit = async (): Promise<void> => {
    const v = form.getFieldsValue(true) as Values;
    const body = buildBody(v, plan);
    try {
      if (plan) {
        const parsed = parseForm(UpdatePlanSchema, body, form, translateKey);
        if (!parsed) return;
        await update.mutateAsync({ id: plan.id, body: parsed });
      } else {
        const parsed = parseForm(
          CreatePlanSchema,
          { ...body, code: v.code?.trim() },
          form,
          translateKey,
        );
        if (!parsed) return;
        await create.mutateAsync(parsed);
      }
      void message.success(t(plan ? 'admin.plans.modal.updated' : 'admin.plans.modal.created'));
      onClose();
    } catch (error) {
      applyToForm(form, error, FIELDS);
    }
  };

  const required = { required: true, message: translateKey('validation.required') };
  return (
    <Modal
      open
      title={t(plan ? 'admin.plans.modal.editTitle' : 'admin.plans.modal.createTitle')}
      okText={t('common.actions.save')}
      cancelText={t('common.actions.cancel')}
      okButtonProps={{ 'data-testid': 'plan-confirm' }}
      confirmLoading={mutation.isPending}
      onOk={() => void submit()}
      onCancel={onClose}
    >
      <Form
        form={form}
        layout="vertical"
        noValidate
        initialValues={{
          currency: 'ILS',
          market: 'PALESTINE',
          ocrPagesMonthly: 0,
          sortOrder: 0,
          isActive: true,
          ...plan,
        }}
      >
        <Form.Item name="code" label={t('admin.plans.columns.code')} rules={[required]}>
          <Input dir="ltr" disabled={!!plan} data-testid="plan-code" />
        </Form.Item>
        <Form.Item name="name" label={t('admin.plans.columns.name')} rules={[required]}>
          <Input maxLength={100} data-testid="plan-name" />
        </Form.Item>
        <Form.Item name="market" label={t('admin.plans.columns.market')}>
          <Select
            options={PLAN_MARKETS.map((m) => ({ value: m, label: t(`enums.planMarket.${m}`) }))}
          />
        </Form.Item>
        <Form.Item name="priceMonthly" label={t('admin.plans.fields.price')} rules={[required]}>
          <Input dir="ltr" inputMode="decimal" data-testid="plan-price" />
        </Form.Item>
        <Form.Item name="currency" label={t('admin.plans.fields.currency')} rules={[required]}>
          <Input dir="ltr" maxLength={3} data-testid="plan-currency" />
        </Form.Item>
        <Form.Item name="maxUsers" label={t('admin.plans.fields.maxUsers')}>
          <InputNumber min={1} placeholder={t('admin.plans.unlimited')} />
        </Form.Item>
        <Form.Item name="aiQuotaMonthly" label={t('admin.plans.fields.aiQuota')}>
          <InputNumber min={0} placeholder={t('admin.plans.unlimited')} />
        </Form.Item>
        <Form.Item name="ocrPagesMonthly" label={t('admin.plans.fields.ocrPages')}>
          <InputNumber min={0} />
        </Form.Item>
        <Form.Item
          name="storageQuotaMb"
          label={t('admin.plans.fields.storageMb')}
          rules={[required]}
        >
          <InputNumber min={1} data-testid="plan-storage" />
        </Form.Item>
        <Form.Item name="trialDays" label={t('admin.plans.fields.trialDays')}>
          <InputNumber min={1} max={3650} placeholder={t('admin.plans.noTrial')} />
        </Form.Item>
        <Form.Item name="sortOrder" label={t('admin.plans.fields.sortOrder')}>
          <InputNumber min={0} />
        </Form.Item>
        <Form.Item label={t('admin.plans.fields.features')}>
          {PLAN_FEATURES.map((feature) => (
            <Form.Item key={feature} name={['features', feature]} valuePropName="checked" noStyle>
              <Checkbox style={{ display: 'flex' }} data-testid={`plan-feature-${feature}`}>
                {t(`settings.subscription.features.${feature}`)}
              </Checkbox>
            </Form.Item>
          ))}
        </Form.Item>
        <Form.Item name="isActive" valuePropName="checked">
          <Checkbox data-testid="plan-active">{t('admin.plans.fields.isActive')}</Checkbox>
        </Form.Item>
      </Form>
      {mutation.isError ? <ApiErrorAlert error={mutation.error} fields={FIELDS} /> : null}
    </Modal>
  );
}
