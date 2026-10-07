import { ErrorState, LoadingSkeleton } from '@nexlegtiq/shared-ui';
import { Navigate, Outlet, useLocation, useSearchParams } from 'react-router';

import { safeNext } from '../forms';
import { restoreSession, useSession } from '../session';
import { IdleTimeout } from './IdleTimeout';

/** Signed-in pages: waits for the app-start restore, then sends anonymous users to sign-in and back here afterwards. */
export function RequireAuth(): React.JSX.Element {
  const status = useSession((state) => state.status);
  const reason = useSession((state) => state.signOutReason);
  const location = useLocation();
  if (status === 'loading') {
    return <LoadingSkeleton />;
  }
  if (status === 'error') {
    // The API could not be reached at start (offline, 5xx, 429): the session may well be valid, so offer a retry.
    return <ErrorState code="SYS-002" onRetry={() => void restoreSession()} />;
  }
  if (status === 'anonymous') {
    const search = new URLSearchParams({ next: location.pathname + location.search });
    if (reason) search.set('reason', reason);
    return <Navigate to={`/login?${search.toString()}`} replace />;
  }
  return (
    <>
      <IdleTimeout />
      <Outlet />
    </>
  );
}

/** Sign-in, signup and forgot-password: a signed-in user goes straight on to where they were heading. */
export function GuestOnly(): React.JSX.Element {
  const status = useSession((state) => state.status);
  const [params] = useSearchParams();
  if (status === 'loading') {
    return <LoadingSkeleton />;
  }
  return status === 'authenticated' ? (
    <Navigate to={safeNext(params.get('next'))} replace />
  ) : (
    <Outlet />
  );
}
