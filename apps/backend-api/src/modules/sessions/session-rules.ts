import type { SessionOutcomeRequest, UpdateSessionRequest } from '@nexlegtiq/shared-contracts';
import type { SessionStatus } from '@nexlegtiq/shared-types';

import type { NewSession, SessionState } from './session-writer';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** A session without an end counts one hour in the conflict check (domain-model invariant 5). */
export const effectiveEnd = (startsAt: Date, endsAt: Date | null): Date =>
  endsAt ?? new Date(startsAt.getTime() + HOUR_MS);

export const toDate = (value: string | null | undefined): Date | null =>
  value ? new Date(value) : null;

/** Derived status (D-116): CANCELLED, COMPLETED once an outcome is recorded, else SCHEDULED. */
export const sessionStatus = (session: {
  isCancelled: boolean;
  outcome: string | null;
}): SessionStatus =>
  session.isCancelled ? 'CANCELLED' : session.outcome ? 'COMPLETED' : 'SCHEDULED';

/**
 * The reminders of a session starting at `startsAt`: one per offset, `days` × 24 h before the start, skipping those
 * already due at `now` (a hearing scheduled for tomorrow gets no 7-day reminder). Instants, so DST never shifts them.
 */
export function reminderRows(
  startsAt: Date,
  days: readonly number[],
  now: Date,
): { daysBefore: number; scheduledFor: Date }[] {
  return [...days]
    .sort((a, b) => b - a)
    .map((daysBefore) => ({
      daysBefore,
      scheduledFor: new Date(startsAt.getTime() - daysBefore * DAY_MS),
    }))
    .filter((row) => row.scheduledFor > now);
}

/**
 * The session an outcome adjourns to: what `next` gives, else the current session's type, court, room and attending
 * lawyer. Same court → same judge unless given; another court → a judge only if given.
 */
export function continuation(
  session: SessionState,
  next: NonNullable<SessionOutcomeRequest['nextSession']>,
): NewSession {
  const courtId = next.courtId === undefined ? session.courtId : next.courtId;
  const sameCourt = courtId === session.courtId;
  return {
    fileId: session.fileId,
    sessionType: next.sessionType ?? session.sessionType,
    startsAt: new Date(next.startsAt),
    endsAt: toDate(next.endsAt),
    courtId,
    judgeId: next.judgeId !== undefined ? next.judgeId : sameCourt ? session.judgeId : null,
    courtRoom: next.courtRoom === undefined ? session.courtRoom : next.courtRoom,
    attendingLawyerId: next.attendingLawyerId ?? session.attendingLawyerId,
    reminderDays: next.reminderDays,
    acknowledgeConflict: next.acknowledgeConflict,
  };
}

/**
 * The fields of `wanted` whose value differs from the session's. Instants are compared as instants (any offset) and
 * `reminderDays` as sets; values are returned as sent (ISO strings), ready for the audit row.
 */
export function changes(
  current: SessionState,
  wanted: Omit<UpdateSessionRequest, 'acknowledgeConflict'>,
): { old: Record<string, unknown>; next: Record<string, unknown> } {
  const old: Record<string, unknown> = {};
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(wanted) as [keyof SessionState, unknown][]) {
    const before = current[key];
    if (value !== undefined && comparable(before) !== comparable(value)) {
      old[key] = before instanceof Date ? before.toISOString() : before;
      next[key] = value;
    }
  }
  return { old, next };
}

/** One comparable value: instants as epoch ms (whatever the offset), day lists as sorted text. */
function comparable(value: unknown): unknown {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value)) return Date.parse(value);
  if (Array.isArray(value)) return [...(value as number[])].sort((a, b) => a - b).join(',');
  return value;
}
