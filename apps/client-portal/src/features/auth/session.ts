import { ApiError, createApiClient, portalApi, portalAuthApi } from '@nexlegtiq/shared-api-client';
import type { PortalClientSession } from '@nexlegtiq/shared-api-client';
import type { PortalUser } from '@nexlegtiq/shared-contracts';
import { QueryClient } from '@tanstack/react-query';
import { create } from 'zustand';

/** Why the client is on the sign-in page; shown there with the `auth.notice.*` texts. */
export type SignOutReason = 'expired' | 'signedOut' | 'passwordReset';

export interface PortalSessionState {
  readonly status: 'loading' | 'authenticated' | 'anonymous' | 'error';
  /** The account and the offices it may enter (their names and contact details brand the portal). */
  readonly user: PortalUser | null;
  /** Memory only, never persisted (D-050). Read by the API client. */
  readonly accessToken: string | null;
  readonly signOutReason: SignOutReason | null;
  /** Why the start-up restore failed when it was not a refusal (`status: 'error'`). */
  readonly startupError: ApiError | null;
}

const INITIAL: PortalSessionState = {
  status: 'loading',
  user: null,
  accessToken: null,
  signOutReason: null,
  startupError: null,
};

export const usePortalSession = create<PortalSessionState>()(() => INITIAL);

const NO_OFFICES: PortalUser['offices'] = [];
/** The offices the account may enter (a stable empty list when signed out: zustand selectors must not build new values). */
export const useOffices = (): PortalUser['offices'] =>
  usePortalSession((state) => state.user?.offices ?? NO_OFFICES);

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
  realm: 'portal',
  getToken: () => usePortalSession.getState().accessToken,
  setToken: (accessToken) => usePortalSession.setState({ accessToken }),
  onAuthFailure: () => endSession('expired'),
});
export const portalAuth = portalAuthApi(apiClient);
export const portal = portalApi(apiClient);

export function startSession(session: PortalClientSession): void {
  usePortalSession.setState({
    status: 'authenticated',
    user: session.user,
    signOutReason: null,
    startupError: null,
  });
}

/** Clears token, account and every cached query. */
export function endSession(reason: SignOutReason | null): void {
  usePortalSession.setState({ ...INITIAL, status: 'anonymous', signOutReason: reason });
  queryClient.clear();
}

/** 401, or 403 AUTH-006 (no live access left): the session is gone. Anything else may be a network problem. */
const isRefusal = (error: unknown): boolean =>
  error instanceof ApiError && (error.status === 401 || error.code === 'AUTH-006');

/** Page load: restore the session from the refresh cookie; offline or a 5xx is `error` (retry offered), not signed out. */
export async function restoreSession(): Promise<void> {
  usePortalSession.setState({ status: 'loading' });
  try {
    startSession(await portalAuth.refresh());
  } catch (error) {
    if (isRefusal(error)) endSession(null);
    else {
      usePortalSession.setState({
        status: 'error',
        startupError: error instanceof ApiError ? error : null,
      });
    }
  }
}

export async function signOut(): Promise<void> {
  try {
    await portalAuth.logout();
  } catch {
    // Offline or the server failed: still signed out here; the refresh cookie expires on its own.
  } finally {
    endSession('signedOut');
  }
}

/** Back to a fresh page load (tests). */
export function resetSession(): void {
  usePortalSession.setState(INITIAL, true);
  queryClient.clear();
}
