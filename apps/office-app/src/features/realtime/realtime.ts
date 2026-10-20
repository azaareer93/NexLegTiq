import { REALTIME_NAMESPACE, RealtimePayloadSchemas } from '@nexlegtiq/shared-contracts';
import type { RealtimeEvent, RealtimePayload } from '@nexlegtiq/shared-contracts';
import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';

import { API_URL, auth, endSession, useSession } from '../auth/session';

type Listener = (payload: unknown) => void;

const listeners = new Map<RealtimeEvent, Set<Listener>>();
let socket: Socket | null = null;
let renewing = false;

const isRealtimeEvent = (event: string): event is RealtimeEvent =>
  Object.hasOwn(RealtimePayloadSchemas, event);

/** Hands a server event to its listeners, only when it matches the contract (the socket is a trust boundary). */
function dispatch(event: string, payload: unknown): void {
  if (!isRealtimeEvent(event)) return;
  const parsed = RealtimePayloadSchemas[event].safeParse(payload);
  if (!parsed.success) return;
  for (const listener of listeners.get(event) ?? []) listener(parsed.data);
}

/**
 * The access token expired under the socket (the server refuses it with AUTH-002, or disconnects it at expiry): get a
 * new one; the token change reconnects. `auth.refresh` runs under the cross-tab lock (D-089) and, unlike
 * `restoreSession`, records no activity — a live socket must never keep an idle session from timing out (D-053).
 */
function renew(): void {
  if (renewing) return;
  renewing = true;
  auth
    .refresh()
    .catch((error: unknown) => {
      // A refused refresh ends the session like any request would; offline keeps it (the next request retries).
      if ((error as { status?: number }).status === 401) endSession('expired');
    })
    .finally(() => {
      renewing = false;
    });
}

function connect(token: string): void {
  socket?.disconnect();
  // Reconnects with exponential backoff (1 s → 30 s, randomised) after a network drop; refusals are handled below.
  const next = io(`${API_URL}${REALTIME_NAMESPACE}`, {
    auth: { token },
    transports: ['websocket'],
    reconnectionDelay: 1_000,
    reconnectionDelayMax: 30_000,
  });
  next.onAny(dispatch);
  next.on('connect_error', (error: Error & { data?: { code?: unknown } }) => {
    if (error.data?.code === 'AUTH-002') renew();
  });
  next.on('disconnect', (reason) => {
    // The server ends a socket when its token expires (D-129); the client does not reconnect on its own then.
    if (reason === 'io server disconnect') renew();
  });
  socket = next;
}

/** Follows the session: a socket per access token (re-authenticated on every refresh), none while signed out. */
export function startRealtime(): () => void {
  const follow = (token: string | null, previous: string | null | undefined): void => {
    if (token === previous) return;
    if (token) connect(token);
    else {
      socket?.disconnect();
      socket = null;
    }
  };
  follow(useSession.getState().accessToken, undefined);
  const stop = useSession.subscribe((state, before) =>
    follow(state.accessToken, before.accessToken),
  );
  return () => {
    stop();
    follow(null, undefined);
  };
}

/** Listens to one event; returns the unsubscribe function. */
export function onRealtime<E extends RealtimeEvent>(
  event: E,
  listener: (payload: RealtimePayload<E>) => void,
): () => void {
  const set = listeners.get(event) ?? new Set<Listener>();
  listeners.set(event, set);
  const entry = listener as Listener;
  set.add(entry);
  return () => set.delete(entry);
}
