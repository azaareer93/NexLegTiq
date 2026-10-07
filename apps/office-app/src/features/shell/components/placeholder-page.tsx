import { EmptyState, PageHeader } from '@nexlegtiq/shared-ui';
import { useTranslation } from 'react-i18next';

import type { NavKey } from '../nav';

/**
 * The page of a menu item whose feature is not built yet. Loaded only through the routes' `lazy` (never re-exported), so it
 * really is its own chunk.
 */
export function PlaceholderPage({
  navKey,
}: {
  readonly navKey: NavKey | 'profile';
}): React.JSX.Element {
  const { t } = useTranslation();
  const title = navKey === 'profile' ? t('shell.profile.profile') : t(`shell.nav.${navKey}`);
  return (
    <section data-testid={`page-${navKey}`}>
      <PageHeader title={title} />
      <EmptyState title={t('shell.comingSoon.title')} description={t('shell.comingSoon.body')} />
    </section>
  );
}
