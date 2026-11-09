import { isErrorCode } from '@nexlegtiq/shared-types';
import { ErrorState, LoadingSkeleton } from '@nexlegtiq/shared-ui';
import { Navigate, Outlet } from 'react-router';

import { restoreSession, useAdminSession } from '../session';
import { IdleTimeout } from './IdleTimeout';

/** Signed-in pages: waits for the start-up restore, sends anyone else to sign-in. */
export function RequireAdmin(): React.JSX.Element {
  const status = useAdminSession((state) => state.status);
  const reason = useAdminSession((state) => state.signOutReason);
  const startupError = useAdminSession((state) => state.startupError);
  if (status === 'loading') return <LoadingSkeleton />;
  if (status === 'error') {
    // Not a refusal: offline (SYS-002), a 5xx, or e.g. AUTH-100 from the IP allow-list — shown as what it is (D-093).
    const code = startupError && isErrorCode(startupError.code) ? startupError.code : 'SYS-002';
    return (
      <ErrorState
        code={code}
        requestId={startupError?.requestId}
        onRetry={() => void restoreSession()}
      />
    );
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
