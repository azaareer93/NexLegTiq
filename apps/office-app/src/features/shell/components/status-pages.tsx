import { ErrorState } from '@nexlegtiq/shared-ui';
import { Button, Result } from 'antd';
import { useTranslation } from 'react-i18next';
import { isRouteErrorResponse, Link, useRouteError } from 'react-router';

function HomeLink(): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <Link to="/" data-testid="go-home">
      {t('shell.goHome')}
    </Link>
  );
}

export function NotFoundPage(): React.JSX.Element {
  const { t } = useTranslation();
  return <Result status="404" title={t('shell.notFound.title')} subTitle={t('shell.notFound.body')} extra={<HomeLink />} data-testid="page-not-found" />;
}

export function ForbiddenPage(): React.JSX.Element {
  const { t } = useTranslation();
  return <Result status="403" title={t('shell.forbidden.title')} subTitle={t('shell.forbidden.body')} extra={<HomeLink />} data-testid="page-forbidden" />;
}

/** A dynamic import that failed: the chunk is gone after a deploy, or the network dropped. Reloading fetches the new one. */
const isChunkLoadError = (error: unknown): boolean =>
  error instanceof Error && /dynamically imported module|Importing a module script failed|Loading chunk/i.test(error.message);

/**
 * The error page of a route (`errorElement`), shown inside the shell for its pages. A thrown 404 response is the 404 page, a
 * failed code chunk offers a reload, anything else (a bug) the generic error with a retry — never the error's own text.
 */
export function RouteError(): React.JSX.Element {
  const { t } = useTranslation();
  const error = useRouteError();
  if (isRouteErrorResponse(error) && error.status === 404) {
    return <NotFoundPage />;
  }
  if (isChunkLoadError(error)) {
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
  return (
    <div data-testid="page-error">
      <ErrorState code="SYS-001" onRetry={() => window.location.reload()} />
    </div>
  );
}
