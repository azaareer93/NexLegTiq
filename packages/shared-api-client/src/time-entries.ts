import { TimeEntrySchema, TimerSchema, TimeTotalsSchema } from '@nexlegtiq/shared-contracts';
import type {
  CreateTimeEntryRequest,
  StartTimerRequest,
  StopTimerRequest,
  TimeEntry,
  TimeEntryQuerySchema,
  Timer,
  TimeTotals,
  UpdateTimeEntryRequest,
} from '@nexlegtiq/shared-contracts';
import type { z } from 'zod';

import type { ApiClient, Page } from './api-client.js';

/** `GET /time-entries` as the app holds it: strings, checked by the API. */
export type TimeEntryListParams = Partial<
  Record<keyof z.input<typeof TimeEntryQuerySchema>, string>
>;

/** Time entries, the running timer and a file's totals (D-152). */
export function timeEntriesApi(client: ApiClient) {
  const path = (id: string) => `time-entries/${encodeURIComponent(id)}`;
  return {
    list: (query: TimeEntryListParams, signal?: AbortSignal): Promise<Page<TimeEntry>> =>
      client.requestPage({ method: 'GET', path: 'time-entries', query, signal }, TimeEntrySchema),
    create: (body: CreateTimeEntryRequest): Promise<TimeEntry> =>
      client.request({ method: 'POST', path: 'time-entries', body }, TimeEntrySchema),
    update: (id: string, body: UpdateTimeEntryRequest): Promise<TimeEntry> =>
      client.request({ method: 'PATCH', path: path(id), body }, TimeEntrySchema),
    remove: (id: string): Promise<void> => client.request({ method: 'DELETE', path: path(id) }),
    /** The caller's running timer, or null. */
    timer: (signal?: AbortSignal): Promise<Timer | null> =>
      client.request({ method: 'GET', path: 'time-entries/timer', signal }, TimerSchema.nullable()),
    startTimer: (body: StartTimerRequest): Promise<Timer> =>
      client.request({ method: 'POST', path: 'time-entries/timer/start', body }, TimerSchema),
    /** Logs the elapsed time as an entry. */
    stopTimer: (body: StopTimerRequest): Promise<TimeEntry> =>
      client.request({ method: 'POST', path: 'time-entries/timer/stop', body }, TimeEntrySchema),
    /** Throws the timer away without logging time; 204. */
    discardTimer: (): Promise<void> =>
      client.request({ method: 'DELETE', path: 'time-entries/timer' }),
    totals: (fileId: string, signal?: AbortSignal): Promise<TimeTotals> =>
      client.request(
        { method: 'GET', path: `cases/${encodeURIComponent(fileId)}/time-totals`, signal },
        TimeTotalsSchema,
      ),
  };
}
