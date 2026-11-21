import { isErrorCode } from '@nexlegtiq/shared-types';
import { ErrorState, LoadingSkeleton } from '@nexlegtiq/shared-ui';
import { Navigate, Outlet } from 'react-router';

import { restoreSession, usePortalSession } from '../session';

/** Signed-in pages: waits for the start-up restore, sends anyone else to sign-in. */
export function RequireClient(): React.JSX.Element {
  const status = usePortalSession((state) => state.status);
  const reason = usePortalSession((state) => state.signOutReason);
  const startupError = usePortalSession((state) => state.startupError);
  if (status === 'loading') return <LoadingSkeleton />;
  if (status === 'error') {
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
  return <Outlet />;
}

/** Sign-in and forgot-password: a signed-in client goes to their files. */
export function GuestOnly(): React.JSX.Element {
  const status = usePortalSession((state) => state.status);
  if (status === 'loading') return <LoadingSkeleton />;
  return status === 'authenticated' ? <Navigate to="/" replace /> : <Outlet />;
}
