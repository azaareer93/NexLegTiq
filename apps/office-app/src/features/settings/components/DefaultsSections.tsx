import type { OfficeSettings } from '@nexlegtiq/shared-contracts';
import { UpdateOfficeSettingsSchema } from '@nexlegtiq/shared-contracts';
import { BILLING_METHODS } from '@nexlegtiq/shared-types';
import { Form, Input, InputNumber, Select, Switch } from 'antd';
import { useTranslation } from 'react-i18next';

import { formValues, SettingsSection, useFieldRules } from './SettingsSection';
import { useUpdateSettings } from '../api/use-office';

const DEFAULTS = [
  'courtReminderDays',
  'taskReminderDays',
  'defaultBillingMethod',
  'defaultBillingRate',
  'taxRatePercent',
  'fileNumberFormat',
  'enableAi',
  'enableOcr',
  'enableVisionOcr',
];
const SECURITY = ['sessionIdleMinutes', 'auditRetentionDays'];
const shape = UpdateOfficeSettingsSchema.shape;
const days = (from: number) =>
  Array.from({ length: 31 - from }, (_, index) => ({ value: from + index, label: from + index }));

interface SectionProps {
  readonly settings: OfficeSettings;
  readonly onDirtyChange: (dirty: boolean) => void;
}

/** Practice defaults for new hearings, tasks, files and invoices, and the AI/OCR switches (D-125). */
export function DefaultsSection({ settings, onDirtyChange }: SectionProps): React.JSX.Element {
  const { t } = useTranslation();
  const save = useUpdateSettings();
  const rules = useFieldRules(shape);
  return (
    <SettingsSection
      title={t('settings.defaults.title')}
      testId="settings-defaults"
      initial={formValues(settings, DEFAULTS)}
      schema={UpdateOfficeSettingsSchema}
      save={save}
      onDirtyChange={onDirtyChange}
    >
      <Form.Item
        name="courtReminderDays"
        label={t('settings.defaults.courtReminderDays')}
        extra={t('settings.defaults.daysBefore')}
        rules={rules('courtReminderDays')}
      >
        <Select
          mode="multiple"
          options={days(1)}
          aria-label={t('settings.defaults.courtReminderDays')}
          data-testid="settings-court-reminders"
        />
      </Form.Item>
      <Form.Item
        name="taskReminderDays"
        label={t('settings.defaults.taskReminderDays')}
        extra={t('settings.defaults.dueDay')}
        rules={rules('taskReminderDays')}
      >
        <Select
          mode="multiple"
          options={days(0)}
          aria-label={t('settings.defaults.taskReminderDays')}
          data-testid="settings-task-reminders"
        />
      </Form.Item>
      <Form.Item name="defaultBillingMethod" label={t('settings.defaults.defaultBillingMethod')}>
        <Select
          data-testid="settings-billing-method"
          options={BILLING_METHODS.map((value) => ({
            value,
            label: t(`enums.billingMethod.${value}`),
          }))}
        />
      </Form.Item>
      <Form.Item
        name="defaultBillingRate"
        label={t('settings.defaults.defaultBillingRate')}
        rules={rules('defaultBillingRate')}
      >
        <Input dir="ltr" inputMode="decimal" data-testid="settings-billing-rate" />
      </Form.Item>
      <Form.Item
        name="taxRatePercent"
        label={t('settings.defaults.taxRatePercent')}
        rules={rules('taxRatePercent')}
      >
        <Input dir="ltr" inputMode="decimal" suffix="%" data-testid="settings-tax-rate" />
      </Form.Item>
      <Form.Item
        name="fileNumberFormat"
        label={t('settings.defaults.fileNumberFormat')}
        extra={t('settings.defaults.fileNumberHelp')}
        rules={rules('fileNumberFormat')}
      >
        <Input dir="ltr" data-testid="settings-file-number-format" />
      </Form.Item>
      <Form.Item name="enableAi" label={t('settings.defaults.enableAi')} valuePropName="checked">
        <Switch data-testid="settings-enable-ai" />
      </Form.Item>
      <Form.Item name="enableOcr" label={t('settings.defaults.enableOcr')} valuePropName="checked">
        <Switch data-testid="settings-enable-ocr" />
      </Form.Item>
      <Form.Item
        name="enableVisionOcr"
        label={t('settings.defaults.enableVisionOcr')}
        extra={t('settings.defaults.enableVisionOcrHint')}
        valuePropName="checked"
      >
        <Switch data-testid="settings-enable-vision-ocr" />
      </Form.Item>
    </SettingsSection>
  );
}

/** Security: the idle sign-out (D-053) and how long the audit log is kept (D-060, upward only). */
export function SecuritySection({ settings, onDirtyChange }: SectionProps): React.JSX.Element {
  const { t } = useTranslation();
  const save = useUpdateSettings();
  const rules = useFieldRules(shape);
  return (
    <SettingsSection
      title={t('settings.security.title')}
      testId="settings-security"
      initial={formValues(settings, SECURITY)}
      schema={UpdateOfficeSettingsSchema}
      save={save}
      onDirtyChange={onDirtyChange}
    >
      <Form.Item
        name="sessionIdleMinutes"
        label={t('settings.security.sessionIdleMinutes')}
        rules={rules('sessionIdleMinutes')}
      >
        <InputNumber min={15} max={120} precision={0} data-testid="settings-idle-minutes" />
      </Form.Item>
      <Form.Item
        name="auditRetentionDays"
        label={t('settings.security.auditRetentionDays')}
        extra={t('settings.security.auditRetentionHelp')}
        rules={rules('auditRetentionDays')}
      >
        <InputNumber min={365} max={3650} precision={0} data-testid="settings-audit-retention" />
      </Form.Item>
    </SettingsSection>
  );
}
