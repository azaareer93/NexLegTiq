import type { Permission } from '@nexlegtiq/shared-types';
import { EmptyState, PageHeader, useCan } from '@nexlegtiq/shared-ui';
import { Button, Result } from 'antd';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Outlet } from 'react-router';

import type { NavKey } from '../nav';

/** The page of a menu item whose feature is not built yet. */
export function PlaceholderPage({ navKey }: { readonly navKey: NavKey | 'profile' }): React.JSX.Element {
  const { t } = useTranslation();
  const title = navKey === 'profile' ? t('shell.profile.profile') : t(`shell.nav.${navKey}`);
  return (
    <section data-testid={`page-${navKey}`}>
      <PageHeader title={title} />
      <EmptyState title={t('shell.comingSoon.title')} description={t('shell.comingSoon.body')} />
    </section>
  );
}

const homeLink = (label: string) => (
  <Link to="/" data-testid="go-home">
    {label}
  </Link>
);

export function NotFoundPage(): React.JSX.Element {
  const { t } = useTranslation();
  return <Result status="404" title={t('shell.notFound.title')} subTitle={t('shell.notFound.body')} extra={homeLink(t('shell.notFound.home'))} data-testid="page-not-found" />;
}

export function ForbiddenPage(): React.JSX.Element {
  const { t } = useTranslation();
  return <Result status="403" title={t('shell.forbidden.title')} subTitle={t('shell.forbidden.body')} extra={homeLink(t('shell.notFound.home'))} data-testid="page-forbidden" />;
}

/** A route that failed to load (usually its code chunk after a deploy or offline): reloading fetches the new one. */
export function RouteError(): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <Result
      status="warning"
      title={t('shell.loadFailed.title')}
      subTitle={t('shell.loadFailed.body')}
      extra={<Button onClick={() => window.location.reload()}>{t('shell.loadFailed.reload')}</Button>}
      data-testid="page-load-failed"
    />
  );
}

export interface RequirePermissionProps {
  readonly perform: Permission;
  readonly children?: ReactNode;
}

/** A page the role may not open shows the 403 page. UI only: the API checks every call again (D-051). */
export function RequirePermission({ perform, children }: RequirePermissionProps): ReactNode {
  const allowed = useCan(perform);
  if (!allowed) {
    return <ForbiddenPage />;
  }
  return children ?? <Outlet />;
}
