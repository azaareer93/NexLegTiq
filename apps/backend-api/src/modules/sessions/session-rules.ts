import type { SessionOutcomeRequest, UpdateSessionRequest } from '@nexlegtiq/shared-contracts';
import type { SessionStatus } from '@nexlegtiq/shared-types';

import type { NewSession, SessionState, Slot } from './session-writer';
import { ValidationException } from '../../common/errors/app.exception';

const HOUR_MS = 3_600_000;

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

/** Reminders are due at 09:00 office time (D-117). */
export const REMINDER_HOUR = 9;

/**
 * The reminders of a session starting at `startsAt` (D-117): one per offset, at 09:00 in the office's time zone `days`
 * calendar days before the hearing's local date. Offsets already due at `now` collapse into one reminder due now (the
 * nearest of them), as long as the hearing is still ahead; a due time at or after the start (a 0-day reminder of an
 * 08:30 hearing) is dropped. Sorted by due time.
 */
export function reminderRows(
  startsAt: Date,
  days: readonly number[],
  now: Date,
  timeZone: string,
): { daysBefore: number; scheduledFor: Date }[] {
  if (startsAt <= now) return [];
  const [year, month, day] = localDate(startsAt, timeZone);
  const rows = days
    .map((daysBefore) => ({
      daysBefore,
      scheduledFor: zonedInstant(year, month, day - daysBefore, REMINDER_HOUR, timeZone),
    }))
    .filter((row) => row.scheduledFor < startsAt);
  const due = rows.filter((row) => row.scheduledFor <= now);
  const ahead = rows.filter((row) => row.scheduledFor > now);
  const nearest = Math.min(...due.map((row) => row.daysBefore));
  return [
    ...(due.length > 0 ? [{ daysBefore: nearest, scheduledFor: now }] : []),
    ...ahead.sort((a, b) => a.scheduledFor.getTime() - b.scheduledFor.getTime()),
  ];
}

/** Calendar date [year, month 1–12, day] of an instant in an IANA zone. */
function localDate(instant: Date, timeZone: string): [number, number, number] {
  const { year, month, day } = zonedParts(instant, timeZone);
  return [year, month, day];
}

const zoneFormats = new Map<string, Intl.DateTimeFormat>();
function zonedParts(instant: Date, timeZone: string) {
  let format = zoneFormats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
    });
    zoneFormats.set(timeZone, format);
  }
  const parts = format.formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
  };
}

/** Offset of a zone from UTC at an instant, in ms (positive east of Greenwich). */
function offsetAt(instant: number, timeZone: string): number {
  const p = zonedParts(new Date(instant), timeZone);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return wall - Math.floor(instant / 60_000) * 60_000;
}

/**
 * The instant of a wall-clock time in a zone (`day` may overflow; Date.UTC normalises it). Two passes settle the offset;
 * DST changes happen at night, far from the 09:00 reminders.
 */
export function zonedInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  timeZone: string,
): Date {
  const wall = Date.UTC(year, month - 1, day, hour);
  const first = wall - offsetAt(wall, timeZone);
  return new Date(wall - offsetAt(first, timeZone));
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
