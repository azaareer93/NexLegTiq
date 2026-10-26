import type { OfficeProfile } from '@nexlegtiq/shared-contracts';
import { UpdateOfficeProfileSchema } from '@nexlegtiq/shared-contracts';
import { JURISDICTIONS, OFFICE_LANGUAGES } from '@nexlegtiq/shared-types';
import { useLanguage } from '@nexlegtiq/shared-ui';
import { Form, Input, Select } from 'antd';
import type { Rule } from 'antd/es/form';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { formValues, SettingsSection, useFieldRules } from './SettingsSection';
import { useUpdateProfile } from '../api/use-office';

const IDENTITY = ['name', 'registrationNumber', 'taxId', 'phone', 'email', 'address', 'website'];
const REGIONAL = ['jurisdiction', 'defaultLanguage', 'currency', 'timezone'];
const CURRENCIES = Intl.supportedValuesOf('currency');
// Region zones only, as the API accepts (D-125).
export const TIME_ZONES = Intl.supportedValuesOf('timeZone').filter(
  (zone) => zone === 'UTC' || (zone.includes('/') && !zone.startsWith('Etc/')),
);
const shape = UpdateOfficeProfileSchema.shape;

function TextField({
  name,
  label,
  rules,
  ltr = false,
}: {
  readonly name: string;
  readonly label: string;
  readonly rules: Rule[];
  readonly ltr?: boolean;
}): React.JSX.Element {
  return (
    <Form.Item name={name} label={label} rules={rules}>
      <Input dir={ltr ? 'ltr' : 'auto'} data-testid={`settings-${name}`} />
    </Form.Item>
  );
}

interface SectionProps {
  readonly profile: OfficeProfile;
  readonly onDirtyChange: (dirty: boolean) => void;
}

/** Office profile: name and the contact details shown on documents and invoices (D-125). */
export function ProfileSection({ profile, onDirtyChange }: SectionProps): React.JSX.Element {
  const { t } = useTranslation();
  const save = useUpdateProfile();
  const rules = useFieldRules(shape);
  return (
    <SettingsSection
      title={t('settings.profile.title')}
      testId="settings-profile"
      initial={formValues(profile, IDENTITY)}
      schema={UpdateOfficeProfileSchema}
      save={save}
      onDirtyChange={onDirtyChange}
    >
      <TextField name="name" label={t('settings.profile.name')} rules={rules('name')} />
      <TextField
        name="registrationNumber"
        label={t('settings.profile.registrationNumber')}
        rules={rules('registrationNumber')}
        ltr
      />
      <TextField name="taxId" label={t('settings.profile.taxId')} rules={rules('taxId')} ltr />
      <TextField name="phone" label={t('settings.profile.phone')} rules={rules('phone')} ltr />
      <TextField name="email" label={t('settings.profile.email')} rules={rules('email')} ltr />
      <Form.Item name="address" label={t('settings.profile.address')} rules={rules('address')}>
        <Input.TextArea dir="auto" autoSize={{ minRows: 2 }} data-testid="settings-address" />
      </Form.Item>
      <TextField
        name="website"
        label={t('settings.profile.website')}
        rules={rules('website')}
        ltr
      />
    </SettingsSection>
  );
}

/** Preferences: the office's jurisdiction, language, currency and time zone — defaults for new files (D-125). */
export function PreferencesSection({ profile, onDirtyChange }: SectionProps): React.JSX.Element {
  const { t } = useTranslation();
  const { locale } = useLanguage();
  const save = useUpdateProfile();
  const rules = useFieldRules(shape);
  const currencyNames = useMemo(
    () => new Intl.DisplayNames(locale, { type: 'currency' }),
    [locale],
  );
  return (
    <SettingsSection
      title={t('settings.preferences.title')}
      testId="settings-preferences"
      initial={formValues(profile, REGIONAL)}
      schema={UpdateOfficeProfileSchema}
      save={save}
      onDirtyChange={onDirtyChange}
    >
      <Form.Item name="jurisdiction" label={t('settings.preferences.jurisdiction')}>
        <Select
          showSearch={{ optionFilterProp: 'label' }}
          data-testid="settings-jurisdiction"
          options={JURISDICTIONS.map((value) => ({
            value,
            label: t(`enums.jurisdiction.${value}`),
          }))}
        />
      </Form.Item>
      <Form.Item name="defaultLanguage" label={t('settings.preferences.defaultLanguage')}>
        <Select
          data-testid="settings-default-language"
          options={OFFICE_LANGUAGES.map((value) => ({
            value,
            label: t(`enums.officeLanguage.${value}`),
          }))}
        />
      </Form.Item>
      <Form.Item
        name="currency"
        label={t('settings.preferences.currency')}
        extra={t('settings.preferences.newFilesOnly')}
        rules={rules('currency')}
      >
        <Select
          showSearch={{ optionFilterProp: 'title' }}
          data-testid="settings-currency"
          options={CURRENCIES.map((value) => {
            const name = currencyNames.of(value) ?? value;
            return {
              value,
              title: `${value} ${name}`,
              label: (
                <>
                  <bdi>{value}</bdi> {name}
                </>
              ),
            };
          })}
        />
      </Form.Item>
      <Form.Item
        name="timezone"
        label={t('settings.preferences.timezone')}
        rules={rules('timezone')}
      >
        <Select
          showSearch={{ optionFilterProp: 'title' }}
          data-testid="settings-timezone"
          options={TIME_ZONES.map((value) => ({
            value,
            title: value,
            label: <bdi dir="ltr">{value}</bdi>,
          }))}
        />
      </Form.Item>
    </SettingsSection>
  );
}
