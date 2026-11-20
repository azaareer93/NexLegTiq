import { isLocale } from '@nexlegtiq/shared-types';
import { useLanguage } from '@nexlegtiq/shared-ui';
import { Segmented } from 'antd';
import { useTranslation } from 'react-i18next';

/** The AR | EN switch; the choice is kept by `LanguageProvider` (Arabic by default). */
export function LanguageSwitch(): React.JSX.Element {
  const { t } = useTranslation();
  const { locale, setLocale } = useLanguage();
  return (
    <Segmented
      aria-label={t('common.language.label')}
      data-testid="language-switch"
      size="small"
      value={locale}
      onChange={(value) => isLocale(value) && setLocale(value)}
      options={[
        { value: 'ar', label: <span lang="ar">{t('common.language.ar')}</span> },
        { value: 'en', label: <span lang="en">{t('common.language.en')}</span> },
      ]}
    />
  );
}
