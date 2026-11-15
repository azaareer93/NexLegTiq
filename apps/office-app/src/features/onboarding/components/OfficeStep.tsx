import { UpdateOfficeProfileSchema } from '@nexlegtiq/shared-contracts';
import { JURISDICTIONS, OFFICE_LANGUAGES } from '@nexlegtiq/shared-types';
import { ApiErrorAlert, useApiErrorHandler } from '@nexlegtiq/shared-ui';
import { App, Button, Form, Input, Select } from 'antd';
import { useTranslation } from 'react-i18next';

import { parseForm } from '../../auth/forms';
import { useOfficeProfile, useUpdateProfile } from '../../settings/api/use-office';
import { TIME_ZONES } from '../../settings/components/ProfileSections';

interface Values {
  readonly jurisdiction?: string;
  readonly defaultLanguage?: string;
  readonly currency?: string;
  readonly timezone?: string;
}

/** Office setup: jurisdiction (Palestine by default), language, currency and time zone, saved to the office (D-125). */
export function OfficeStep() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const { translateKey } = useApiErrorHandler();
  const profile = useOfficeProfile();
  const update = useUpdateProfile();
  const [form] = Form.useForm<Values>();
  if (!profile.data) return null;
  const { jurisdiction, defaultLanguage, currency, timezone } = profile.data;
  const save = async () => {
    const v = form.getFieldsValue(true) as Values;
    const parsed = parseForm(UpdateOfficeProfileSchema, v, form, translateKey);
    if (!parsed) return;
    await update.mutateAsync(parsed);
    void message.success(t('onboarding.office.saved'));
  };
  return (
    <Form
      form={form}
      layout="vertical"
      noValidate
      initialValues={{ jurisdiction, defaultLanguage, currency, timezone }}
      style={{ maxInlineSize: 420 }}
    >
      <Form.Item name="jurisdiction" label={t('onboarding.office.jurisdiction')}>
        <Select
          data-testid="onboarding-jurisdiction"
          options={JURISDICTIONS.map((j) => ({ value: j, label: t(`enums.jurisdiction.${j}`) }))}
        />
      </Form.Item>
      <Form.Item name="defaultLanguage" label={t('onboarding.office.language')}>
        <Select
          data-testid="onboarding-language"
          options={OFFICE_LANGUAGES.map((l) => ({
            value: l,
            label: t(`enums.officeLanguage.${l}`),
          }))}
        />
      </Form.Item>
      <Form.Item name="currency" label={t('onboarding.office.currency')}>
        <Input dir="ltr" maxLength={3} data-testid="onboarding-currency" />
      </Form.Item>
      <Form.Item name="timezone" label={t('onboarding.office.timezone')}>
        <Select
          showSearch
          data-testid="onboarding-timezone"
          options={TIME_ZONES.map((value) => ({ value, label: <span dir="ltr">{value}</span> }))}
        />
      </Form.Item>
      <Button
        type="primary"
        loading={update.isPending}
        onClick={() => void save().catch(() => undefined)}
        data-testid="onboarding-office-save"
      >
        {t('onboarding.office.save')}
      </Button>
      {update.isError ? <ApiErrorAlert error={update.error} /> : null}
    </Form>
  );
}
