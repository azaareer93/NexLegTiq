import { EmptyState } from '@nexlegtiq/shared-ui';
import { useTranslation } from 'react-i18next';

/** A tab whose story has not shipped yet. */
export function ComingSoonTab(): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <EmptyState title={t('shell.comingSoon.title')} description={t('shell.comingSoon.body')} />
  );
}
