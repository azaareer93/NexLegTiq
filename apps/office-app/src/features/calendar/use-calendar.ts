import { sessionsApi, tasksApi } from '@nexlegtiq/shared-api-client';
import type { SessionListItem, Task } from '@nexlegtiq/shared-contracts';
import { wallClock, zonedDateTime } from '@nexlegtiq/shared-utils';
import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { apiClient } from '../auth';

const sessions = sessionsApi(apiClient);
const tasks = tasksApi(apiClient);

const DAY_MS = 86_400_000;
/** `YYYY-MM-DD` plus `days` (calendar arithmetic). */
export const addDays = (date: string, days: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/** A calendar range: the first and last day shown (both included), in the office's calendar. */
export interface CalendarRange {
  readonly first: string;
  readonly last: string;
}

export interface CalendarFilters {
  readonly lawyerId?: string;
  readonly fileId?: string;
}

/** One entry on the calendar: a hearing at its office-time day, or a task on its due day. */
export type CalendarEntry =
  | { readonly kind: 'hearing'; readonly day: string; readonly session: SessionListItem }
  | { readonly kind: 'task'; readonly day: string; readonly task: Task };

/** At most this many tasks are drawn for a range (one page of the tasks list). */
const TASK_LIMIT = 100;

/**
 * The hearings (`GET /sessions?from&to`, D-116) and due tasks (`GET /tasks?dueFrom&dueBefore`) of a range, sorted by day
 * then time, in the office's time zone (D-127): a hearing at 23:30 in Hebron belongs to that Hebron day.
 */
export function useCalendar(range: CalendarRange, filters: CalendarFilters, timeZone: string) {
  const from = zonedDateTime(range.first, '00:00', timeZone);
  const to = zonedDateTime(addDays(range.last, 1), '00:00', timeZone);
  const hearings = useQuery({
    queryKey: ['sessions', 'calendar', { from, to, ...filters }],
    queryFn: ({ signal }) => sessions.calendar({ from, to, ...filters }, signal),
    placeholderData: keepPreviousData,
  });
  const due = useQuery({
    queryKey: ['tasks', 'calendar', { ...range, ...filters }],
    queryFn: ({ signal }) =>
      tasks.list(
        {
          dueFrom: range.first,
          dueBefore: range.last,
          limit: String(TASK_LIMIT),
          ...(filters.lawyerId ? { assignee: filters.lawyerId } : {}),
          ...(filters.fileId ? { fileId: filters.fileId } : {}),
        },
        signal,
      ),
    placeholderData: keepPreviousData,
  });
  const entries: CalendarEntry[] = [
    ...(hearings.data ?? [])
      .filter((session) => session.status !== 'CANCELLED')
      .map((session) => ({
        kind: 'hearing' as const,
        day: wallClock(session.startsAt, timeZone).date,
        session,
      })),
    ...(due.data?.items ?? []).flatMap((task) =>
      task.dueDate ? [{ kind: 'task' as const, day: task.dueDate, task }] : [],
    ),
  ].sort((a, b) => a.day.localeCompare(b.day) || sortKey(a).localeCompare(sortKey(b)));
  return {
    entries,
    isPending: hearings.isPending || due.isPending,
    error: hearings.error ?? due.error,
    // shortcut: tasks beyond one page of 100 are not drawn; page the tasks query if a range ever holds more.
    truncated: (due.data?.pagination.total ?? 0) > TASK_LIMIT,
    refetch: () => {
      void hearings.refetch();
      void due.refetch();
    },
  };
}

/** Hearings by their start, tasks (no time) after them. */
const sortKey = (entry: CalendarEntry): string =>
  entry.kind === 'hearing' ? entry.session.startsAt : '~';
