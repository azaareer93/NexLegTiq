import { authApi, createApiClient, usersApi } from '@nexlegtiq/shared-api-client';
import type { ClientSession } from '@nexlegtiq/shared-api-client';
import type { AuthUser } from '@nexlegtiq/shared-contracts';
import { QueryClient } from '@tanstack/react-query';
import { create } from 'zustand';

/** Why the user is on the sign-in page; shown as a notice there. */
export type SignOutReason = 'idle' | 'expired' | 'signedOut';

/** Default idle timeout (D-053) until the office setting is readable (office settings API, MVP-48). */
export const DEFAULT_IDLE_MINUTES = 30;

export interface SessionState {
  /** `loading` until the app-start restore has answered. */
  readonly status: 'loading' | 'authenticated' | 'anonymous';
  readonly user: AuthUser | null;
  /** Memory only: never persisted, never in React Query (D-050). Read by the API client. */
  readonly accessToken: string | null;
  readonly idleMinutes: number;
  readonly signOutReason: SignOutReason | null;
}

const INITIAL: SessionState = {
  status: 'loading',
  user: null,
  accessToken: null,
  idleMinutes: DEFAULT_IDLE_MINUTES,
  signOutReason: null,
};

export const useSession = create<SessionState>()(() => INITIAL);

export const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });

export const API_URL: string = import.meta.env['VITE_API_URL'] ?? 'http://localhost:3000';

export const apiClient = createApiClient({
  baseURL: API_URL,
  realm: 'office',
  getToken: () => useSession.getState().accessToken,
  setToken: (accessToken) => useSession.setState({ accessToken }),
  // The session was lost mid-use (refresh refused): the guards send the user to sign-in with a notice.
  onAuthFailure: () => endSession('expired'),
});
export const auth = authApi(apiClient);
export const users = usersApi(apiClient);

/**
 * Tells the other tabs of this browser about sign-in, sign-out and activity, so they follow (sign-out everywhere, idle
 * timeout counted across tabs). No secrets travel: each tab restores its own token from the refresh cookie.
 */
type SessionMessage = { type: 'signedIn' } | { type: 'signedOut' } | { type: 'activity'; at: number };
const channel: BroadcastChannel | null = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('nlq-session');
const activityListeners = new Set<(at: number) => void>();

export function broadcast(message: SessionMessage): void {
  channel?.postMessage(message);
}

/** Activity seen in another tab (for the idle timeout). */
export function onRemoteActivity(listener: (at: number) => void): () => void {
  activityListeners.add(listener);
  return () => activityListeners.delete(listener);
}

if (channel) {
  channel.onmessage = ({ data }: MessageEvent<SessionMessage>) => {
    if (data.type === 'activity') {
      activityListeners.forEach((listener) => listener(data.at));
    } else if (data.type === 'signedOut' && useSession.getState().status === 'authenticated') {
      endSession('signedOut');
    } else if (data.type === 'signedIn' && useSession.getState().status === 'anonymous') {
      void restoreSession();
    }
  };
}

export function startSession(session: ClientSession): void {
  useSession.setState({ status: 'authenticated', user: session.user, signOutReason: null });
}

/** Clears everything this tab knows about the session: token, user and every cached query. */
export function endSession(reason: SignOutReason | null): void {
  useSession.setState({ status: 'anonymous', user: null, accessToken: null, signOutReason: reason });
  queryClient.clear();
}

/** App start (and another tab signing in): restore the session from the refresh cookie, if there is one. */
export async function restoreSession(): Promise<void> {
  try {
    startSession(await auth.refresh());
  } catch {
    // No cookie, an expired session or the API unreachable: the user signs in again.
    useSession.setState({ status: 'anonymous', user: null, accessToken: null });
  }
}

/** Signs out on the server (best effort), here and in the other tabs. */
export async function signOut(reason: SignOutReason = 'signedOut'): Promise<void> {
  try {
    await auth.logout();
  } catch {
    // Offline or the server failed: still signed out locally; the refresh cookie then expires on its own.
  } finally {
    endSession(reason);
    broadcast({ type: 'signedOut' });
  }
}

/** Back to the state of a fresh page load (tests). */
export function resetSession(): void {
  useSession.setState(INITIAL, true);
  queryClient.clear();
}
