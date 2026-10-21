import type { RealtimeEvent, RealtimePayload } from '@nexlegtiq/shared-contracts';
import { useQueryClient } from '@tanstack/react-query';
import type { QueryKey } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';

import { onRealtime } from './realtime';

/** Runs `handler` for every `event` pushed while the component is mounted (the latest handler, no resubscribing). */
export function useRealtime<E extends RealtimeEvent>(
  event: E,
  handler: (payload: RealtimePayload<E>) => void,
): void {
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });
  useEffect(() => onRealtime(event, (payload) => latest.current(payload)), [event]);
}

/**
 * Refetches the queries an event makes stale. Events carry ids only (D-129), so the data always comes back through the
 * API and its access rules.
 */
export function useInvalidateOn<E extends RealtimeEvent>(
  event: E,
  keys: (payload: RealtimePayload<E>) => readonly QueryKey[],
): void {
  const queryClient = useQueryClient();
  useRealtime(event, (payload) => {
    for (const queryKey of keys(payload)) void queryClient.invalidateQueries({ queryKey });
  });
}
