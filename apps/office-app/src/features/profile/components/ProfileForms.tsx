import { UpdateProfileSchema } from '@nexlegtiq/shared-contracts';
import type { Profile } from '@nexlegtiq/shared-contracts';
import { DIGIT_STYLES } from '@nexlegtiq/shared-types';
import { Ltr } from '@nexlegtiq/shared-ui';
import { isolateLtr } from '@nexlegtiq/shared-utils';
import { Form, Input, Select } from 'antd';
import { useTranslation } from 'react-i18next';

import { useSession } from '../../auth';
import { TIME_ZONES } from '../../settings/components/ProfileSections';
import {
  formValues,
  SettingsSection,
  useFieldRules,
} from '../../settings/components/SettingsSection';
import { useUpdateProfile } from '../api/use-profile';

const shape = UpdateProfileSchema.shape;
const noop = () => undefined;

/** Name and phone; the sign-in email is shown, not edited (the office manager changes it). */
export function PersonalForm({ profile }: { readonly profile: Profile }): React.JSX.Element {
  const { t } = useTranslation();
  const rules = useFieldRules(shape);
  const save = useUpdateProfile();
  return (
    <SettingsSection
      title={t('profile.personal.title')}
      testId="profile-personal"
      initial={formValues(profile, ['fullName', 'phone'])}
      schema={UpdateProfileSchema}
      save={save}
      onDirtyChange={noop}
    >
      <Form.Item name="fullName" label={t('profile.personal.fullName')} rules={rules('fullName')}>
        <Input autoComplete="name" data-testid="profile-full-name" />
      </Form.Item>
      <Form.Item name="phone" label={t('profile.personal.phone')} rules={rules('phone')}>
        <Input dir="ltr" autoComplete="tel" data-testid="profile-phone" />
      </Form.Item>
      <Form.Item label={t('profile.personal.email')} extra={t('profile.personal.emailHint')}>
        <span data-testid="profile-email">
          <Ltr>{profile.email}</Ltr>
        </span>
      </Form.Item>
    </SettingsSection>
  );
}

/**
 * Language, the user's own time zone (for what is sent to them; screens stay on the office's, D-127) and digits. A saved
 * language or digit style applies to the whole app at once (the session follows, D-146).
 */
export function DisplayForm({ profile }: { readonly profile: Profile }): React.JSX.Element {
  const { t } = useTranslation();
  const rules = useFieldRules(shape);
  const save = useUpdateProfile();
  const officeZone = useSession((state) => state.user?.timeZone) ?? '';
  return (
    <SettingsSection
      title={t('profile.preferences.title')}
      testId="profile-display"
      initial={formValues(profile, ['uiLanguage', 'timezone', 'digitStyle'])}
      schema={UpdateProfileSchema}
      save={save}
      onDirtyChange={noop}
    >
      <Form.Item name="uiLanguage" label={t('profile.preferences.language')}>
        <Select
          data-testid="profile-language"
          options={[
            { value: 'AR', label: <span lang="ar">{t('common.language.ar')}</span> },
            { value: 'EN', label: <span lang="en">{t('common.language.en')}</span> },
          ]}
        />
      </Form.Item>
      <Form.Item
        name="timezone"
        label={t('profile.preferences.timezone')}
        extra={t('profile.preferences.timezoneHint')}
        rules={rules('timezone')}
      >
        <Select
          showSearch={{ optionFilterProp: 'title' }}
          data-testid="profile-timezone"
          options={[
            {
              value: '',
              title: officeZone,
              label: t('profile.preferences.timezoneOffice', { zone: isolateLtr(officeZone) }),
            },
            ...TIME_ZONES.map((value) => ({
              value,
              title: value,
              label: <bdi dir="ltr">{value}</bdi>,
            })),
          ]}
        />
      </Form.Item>
      <Form.Item name="digitStyle" label={t('profile.preferences.digits')}>
        <Select
          data-testid="profile-digits"
          options={DIGIT_STYLES.map((value) => ({
            value,
            label: t(`enums.digitStyle.${value}`),
          }))}
        />
      </Form.Item>
    </SettingsSection>
  );
}
