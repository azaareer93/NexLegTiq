import { ErrorState, LoadingSkeleton } from '@nexlegtiq/shared-ui';
import { Navigate, Outlet } from 'react-router';

import { restoreSession, useAdminSession } from '../session';
import { IdleTimeout } from './IdleTimeout';

/** Signed-in pages: waits for the start-up restore, sends anyone else to sign-in. */
export function RequireAdmin(): React.JSX.Element {
  const status = useAdminSession((state) => state.status);
  const reason = useAdminSession((state) => state.signOutReason);
  if (status === 'loading') return <LoadingSkeleton />;
  if (status === 'error') {
    // The API was unreachable at start: the session may be fine, so offer a retry.
    return <ErrorState code="SYS-002" onRetry={() => void restoreSession()} />;
  }
  if (status === 'anonymous') {
    return <Navigate to={reason ? `/login?reason=${reason}` : '/login'} replace />;
  }
  return (
    <>
      <IdleTimeout />
      <Outlet />
    </>
  );
}

/** Sign-in and enrolment: a signed-in admin goes to the panel. */
export function GuestOnly(): React.JSX.Element {
  const status = useAdminSession((state) => state.status);
  if (status === 'loading') return <LoadingSkeleton />;
  return status === 'authenticated' ? <Navigate to="/" replace /> : <Outlet />;
}
