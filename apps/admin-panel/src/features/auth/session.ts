import { ApiError, adminAuthApi, createApiClient } from '@nexlegtiq/shared-api-client';
import type { AdminClientSession } from '@nexlegtiq/shared-api-client';
import type { AdminProfile } from '@nexlegtiq/shared-contracts';
import { QueryClient } from '@tanstack/react-query';
import { create } from 'zustand';

/** Why the admin is on the sign-in page; shown there with the office app's `auth.notice.*` texts. */
export type SignOutReason = 'idle' | 'expired' | 'signedOut';

/** D-053 / D-145: the admin session ends after 30 minutes without activity (the server refuses a refresh after that too). */
export const IDLE_MINUTES = 30;

export interface AdminSessionState {
  readonly status: 'loading' | 'authenticated' | 'anonymous' | 'error';
  readonly admin: AdminProfile | null;
  /** Memory only, never persisted (D-050). Read by the API client. */
  readonly accessToken: string | null;
  readonly signOutReason: SignOutReason | null;
  /**
   * The credentials typed on the sign-in page of a not-yet-enrolled admin: enrolment asks for them again (D-145). Held
   * here in memory, never in the URL or `history.state` (which browsers keep in their session history).
   */
  readonly pendingEnrollment: { readonly email: string; readonly password: string } | null;
}

const INITIAL: AdminSessionState = {
  status: 'loading',
  admin: null,
  accessToken: null,
  signOutReason: null,
  pendingEnrollment: null,
};

export const useAdminSession = create<AdminSessionState>()(() => INITIAL);

export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

const configuredApiUrl = import.meta.env['VITE_API_URL'] as string | undefined;
if (import.meta.env.PROD && !configuredApiUrl?.startsWith('https://')) {
  throw new Error('VITE_API_URL must be set to the https:// API origin in a production build');
}
export const API_URL = configuredApiUrl ?? 'http://localhost:3000';

export const apiClient = createApiClient({
  baseURL: API_URL,
  realm: 'admin',
  getToken: () => useAdminSession.getState().accessToken,
  setToken: (accessToken) => useAdminSession.setState({ accessToken }),
  onAuthFailure: () => endSession('expired'),
});
export const adminAuth = adminAuthApi(apiClient);

export function startSession(session: AdminClientSession): void {
  useAdminSession.setState({
    status: 'authenticated',
    admin: session.admin,
    signOutReason: null,
    pendingEnrollment: null,
  });
}

/** Clears token, admin, pending credentials and every cached query. */
export function endSession(reason: SignOutReason | null): void {
  useAdminSession.setState({ ...INITIAL, status: 'anonymous', signOutReason: reason });
  queryClient.clear();
}

/** 401, or 403 AUTH-006 (deactivated admin): the session is gone. Anything else may be a network problem. */
const isRefusal = (error: unknown): boolean =>
  error instanceof ApiError && (error.status === 401 || error.code === 'AUTH-006');

/** Page load: restore the session from the refresh cookie; offline or a 5xx is `error` (retry offered), not signed out. */
export async function restoreSession(): Promise<void> {
  useAdminSession.setState({ status: 'loading' });
  try {
    startSession(await adminAuth.refresh());
  } catch (error) {
    if (isRefusal(error)) endSession(null);
    else useAdminSession.setState({ status: 'error' });
  }
}

export async function signOut(reason: SignOutReason = 'signedOut'): Promise<void> {
  try {
    await adminAuth.logout();
  } catch {
    // Offline or the server failed: still signed out here; the refresh cookie expires on its own (30 min idle, D-145).
  } finally {
    endSession(reason);
  }
}

/** Back to a fresh page load (tests). */
export function resetSession(): void {
  useAdminSession.setState(INITIAL, true);
  queryClient.clear();
}
