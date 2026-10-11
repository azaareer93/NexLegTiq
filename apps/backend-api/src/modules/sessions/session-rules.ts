import type { SessionOutcomeRequest, UpdateSessionRequest } from '@nexlegtiq/shared-contracts';
import type { SessionStatus } from '@nexlegtiq/shared-types';

import type { NewSession, SessionState, Slot } from './session-writer';
import { ValidationException } from '../../common/errors/app.exception';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** A session without an end counts one hour in the conflict check (domain-model invariant 5). */
export const effectiveEnd = (startsAt: Date, endsAt: Date | null): Date =>
  endsAt ?? new Date(startsAt.getTime() + HOUR_MS);

/** The longest session (CHECK `sessions_duration_check`); also bounds the conflict query. */
export const MAX_SESSION_MS = 24 * HOUR_MS;

/** Why an end is refused (an i18n key), or null: it must follow the start, by at most 24 hours. */
export function durationProblem(startsAt: Date, endsAt: Date | null): string | null {
  if (!endsAt) return null;
  if (endsAt <= startsAt) return 'validation.endsBeforeStart';
  return endsAt.getTime() - startsAt.getTime() > MAX_SESSION_MS
    ? 'validation.sessionTooLong'
    : null;
}

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
    if (value !== undefined && comparable(key, before) !== comparable(key, value)) {
      old[key] = before instanceof Date ? before.toISOString() : before;
      next[key] = value;
    }
  }
  return { old, next };
}

/** One comparable value: instants as epoch ms (whatever the offset), day lists as sorted text. */
function comparable(key: keyof SessionState, value: unknown): unknown {
  if (value instanceof Date) return value.getTime();
  if ((key === 'startsAt' || key === 'endsAt') && typeof value === 'string')
    return Date.parse(value);
  if (Array.isArray(value)) return [...(value as number[])].sort((a, b) => a - b).join(',');
  return value;
}

/** Changing any of these re-runs the conflict check. */
export const SLOT_FIELDS = ['startsAt', 'endsAt', 'attendingLawyerId'] as const;

/** Start, end and attending lawyer after a PATCH; 400 when the end is not after the start or too late. */
export function nextSlot(session: SessionState, input: UpdateSessionRequest): Slot {
  const slot = {
    startsAt: input.startsAt ? new Date(input.startsAt) : session.startsAt,
    endsAt: input.endsAt === undefined ? session.endsAt : toDate(input.endsAt),
    attendingLawyerId: input.attendingLawyerId ?? session.attendingLawyerId,
  };
  const problem = durationProblem(slot.startsAt, slot.endsAt);
  if (problem) throw new ValidationException([{ field: 'endsAt', message: problem }]);
  return slot;
}

/** The slot fields a PATCH changes, as the values to write (instants as dates). */
export const slotChanges = (slot: Slot, next: Record<string, unknown>): Partial<Slot> =>
  Object.fromEntries(
    SLOT_FIELDS.filter((field) => field in next).map((field) => [field, slot[field]]),
  );

/** A new court without a judge also drops the old court's judge (nextCourtRefs): the audit row says so too. */
export function auditJudge(
  old: Record<string, unknown>,
  next: Record<string, unknown>,
  before: string | null,
  after: string | null | undefined,
): void {
  if (after === undefined || after === before) return;
  old['judgeId'] = before;
  next['judgeId'] = after;
}

/** SESSION_UPDATED payload of a PATCH: type and start after it, and the start before when it moved. */
export function updatedPayload(
  session: SessionState,
  input: UpdateSessionRequest,
  slot: Slot,
): Record<string, string> {
  const moved = slot.startsAt.getTime() !== session.startsAt.getTime();
  return {
    change: 'UPDATED',
    sessionType: input.sessionType ?? session.sessionType,
    startsAt: slot.startsAt.toISOString(),
    ...(moved && { previousStartsAt: session.startsAt.toISOString() }),
  };
}
