import { ApiError, authApi, createApiClient } from '@nexlegtiq/shared-api-client';
import type { ClientSession } from '@nexlegtiq/shared-api-client';
import type { AuthUser } from '@nexlegtiq/shared-contracts';
import { QueryClient } from '@tanstack/react-query';
import { create } from 'zustand';

/** Why the user is on the sign-in page; shown as a notice there. */
export type SignOutReason = 'idle' | 'expired' | 'signedOut';
const SIGN_OUT_REASONS: readonly SignOutReason[] = ['idle', 'expired', 'signedOut'];

/** Default idle timeout (D-053) until the office setting is readable (office settings API, MVP-48). */
export const DEFAULT_IDLE_MINUTES = 30;

export interface SessionState {
  /** `loading` until the app-start restore has answered; `error` when it could not reach the API (retry offered). */
  readonly status: 'loading' | 'authenticated' | 'anonymous' | 'error';
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

export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

const configuredApiUrl: string | undefined = import.meta.env['VITE_API_URL'];
if (import.meta.env.PROD && !configuredApiUrl?.startsWith('https://')) {
  throw new Error('VITE_API_URL must be set to the https:// API origin in a production build');
}
export const API_URL = configuredApiUrl ?? 'http://localhost:3000';

export const apiClient = createApiClient({
  baseURL: API_URL,
  realm: 'office',
  getToken: () => useSession.getState().accessToken,
  setToken: (accessToken) => useSession.setState({ accessToken }),
  // The session was lost mid-use (refresh refused): the guards send the user to sign-in with a notice.
  onAuthFailure: () => endSession('expired'),
});
export const auth = authApi(apiClient);

/**
 * When this browser last saw activity, for the idle timeout across page loads: closing the tab must not reset it (a
 * shared office computer, D-053). A timestamp only, nothing secret; a convenience, so unavailable storage is ignored.
 */
const LAST_ACTIVITY_KEY = 'nlq.lastActivity';

export function recordActivity(at = Date.now()): void {
  try {
    localStorage.setItem(LAST_ACTIVITY_KEY, String(at));
  } catch {
    // Storage blocked: the idle timeout still applies while a tab is open.
  }
}

function idleSinceLastVisit(): boolean {
  try {
    const at = Number(localStorage.getItem(LAST_ACTIVITY_KEY));
    return at > 0 && Date.now() - at >= useSession.getState().idleMinutes * 60_000;
  } catch {
    return false;
  }
}

/**
 * Tells the other tabs of this browser about sign-in, sign-out and activity, so they follow (sign-out everywhere, idle
 * timeout counted across tabs). No secrets travel: each tab restores its own token from the refresh cookie. Messages come
 * from same-origin scripts only, and are checked before use.
 */
type SessionMessage =
  | { type: 'signedIn' }
  | { type: 'signedOut'; reason: SignOutReason }
  | { type: 'activity'; at: number };
const channel: BroadcastChannel | null =
  typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('nlq-session');
const activityListeners = new Set<(at: number) => void>();

export function broadcast(message: SessionMessage): void {
  channel?.postMessage(message);
}

/** Activity seen in another tab (for the idle timeout). */
export function onRemoteActivity(listener: (at: number) => void): () => void {
  activityListeners.add(listener);
  return () => activityListeners.delete(listener);
}

function onMessage(data: unknown): void {
  const message = data as Partial<Record<string, unknown>> | null;
  if (
    message?.['type'] === 'activity' &&
    typeof message['at'] === 'number' &&
    Number.isFinite(message['at'])
  ) {
    // Never in the future: a bogus timestamp must not switch the idle timeout off.
    const at = Math.min(message['at'], Date.now());
    activityListeners.forEach((listener) => listener(at));
  } else if (
    message?.['type'] === 'signedOut' &&
    useSession.getState().status === 'authenticated'
  ) {
    const reason = SIGN_OUT_REASONS.find((known) => known === message['reason']) ?? 'signedOut';
    endSession(reason);
  } else if (message?.['type'] === 'signedIn') {
    // Another tab signed in, possibly as someone else (the refresh cookie is shared): re-check who this tab is.
    void restoreSession();
  }
}

if (channel) {
  channel.onmessage = ({ data }: MessageEvent<unknown>) => onMessage(data);
}

export function startSession(session: ClientSession): void {
  const current = useSession.getState().user;
  if (current && current.id !== session.user.id) {
    // A different user now owns the cookie: nothing of the previous user's data may stay on screen.
    queryClient.clear();
  }
  recordActivity();
  useSession.setState({ status: 'authenticated', user: session.user, signOutReason: null });
}

/** Clears everything this tab knows about the session: token, user and every cached query and mutation. */
export function endSession(reason: SignOutReason | null): void {
  useSession.setState({
    status: 'anonymous',
    user: null,
    accessToken: null,
    signOutReason: reason,
  });
  queryClient.clear();
  try {
    // No session, nothing to time out: the next visit must not report "signed out after inactivity".
    localStorage.removeItem(LAST_ACTIVITY_KEY);
  } catch {
    // Storage blocked: nothing was recorded either.
  }
}

/** The server refused the session (no cookie, expired, revoked, inactive): the user must sign in. */
const isRefusal = (error: unknown): boolean =>
  error instanceof ApiError &&
  (error.status === 401 || error.code === 'AUTH-006' || error.code === 'AUTH-010');

/**
 * App start, a retry after a failed start, and another tab signing in: restore the session from the refresh cookie.
 * Offline, a 5xx or a 429 is not "signed out": the page offers a retry and the cookie stays valid.
 */
export async function restoreSession(): Promise<void> {
  const before = useSession.getState().status;
  if (before !== 'authenticated') {
    useSession.setState({ status: 'loading' });
  }
  if (before !== 'authenticated' && idleSinceLastVisit()) {
    // The browser was left idle (or closed) for longer than the idle timeout: end that session instead of resuming it.
    await signOut('idle');
    return;
  }
  try {
    startSession(await auth.refresh());
  } catch (error) {
    if (isRefusal(error)) {
      endSession(before === 'authenticated' ? 'expired' : null);
    } else if (before !== 'authenticated') {
      useSession.setState({ status: 'error' });
    }
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
    broadcast({ type: 'signedOut', reason });
  }
}

/** Back to the state of a fresh page load (tests). */
export function resetSession(): void {
  useSession.setState(INITIAL, true);
  queryClient.clear();
}
