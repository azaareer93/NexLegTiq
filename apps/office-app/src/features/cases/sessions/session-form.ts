import type {
  CreateSessionSchema,
  Session,
  SessionListItem,
  UpdateSessionSchema,
} from '@nexlegtiq/shared-contracts';
import type { SessionType } from '@nexlegtiq/shared-types';
import { isApiError } from '@nexlegtiq/shared-ui';
import { wallClock, zonedDateTime } from '@nexlegtiq/shared-utils';
import dayjs from 'dayjs';
import type { Dayjs } from 'dayjs';
import type { z } from 'zod';

/**
 * The hearing form (D-127). Pickers hold the office's wall clock as plain local Dayjs values; it becomes an instant with
 * the office's offset only when sent, so the device's own zone never matters.
 */
export interface SessionFormValues {
  sessionType: SessionType;
  date?: Dayjs | null;
  /** Times of `date`, named as the API's fields so its VAL-001 details land on them. */
  startsAt?: Dayjs | null;
  endsAt?: Dayjs | null;
  courtId?: string | null;
  judgeId?: string | null;
  courtRoom?: string;
  attendingLawyerId?: string;
  reminderDays?: number[];
}

export type CreateSessionBody = z.input<typeof CreateSessionSchema>;
export type UpdateSessionBody = z.input<typeof UpdateSessionSchema>;

/** Offered reminder offsets (days before); the API accepts 0–365. */
export const REMINDER_DAY_OPTIONS = [0, 1, 2, 3, 5, 7, 10, 14, 21, 30] as const;

const instant = (date: Dayjs, time: Dayjs, timeZone: string) =>
  zonedDateTime(date.format('YYYY-MM-DD'), time.format('HH:mm'), timeZone);

/** The office wall clock of an instant, as a Dayjs the pickers show as is. */
export const pickerValue = (iso: string, timeZone: string): Dayjs => {
  const { date, time } = wallClock(iso, timeZone);
  return dayjs(`${date}T${time}`);
};

/** Start and optional end of the form as instants (undefined while the date or the time is missing). */
export function formTimes(
  values: Pick<SessionFormValues, 'date' | 'startsAt' | 'endsAt'>,
  timeZone: string,
): { startsAt?: string; endsAt?: string | null } {
  if (!values.date || !values.startsAt) return {};
  return {
    startsAt: instant(values.date, values.startsAt, timeZone),
    endsAt: values.endsAt ? instant(values.date, values.endsAt, timeZone) : null,
  };
}

const trimmed = (value: string | undefined) => {
  const text = value?.trim();
  return text ? text : undefined;
};

/** `POST /sessions`: only what was filled in; reminder days left empty take the office's default. */
export function createBody(
  values: SessionFormValues,
  fileId: string,
  timeZone: string,
): CreateSessionBody {
  const { startsAt, endsAt } = formTimes(values, timeZone);
  return {
    fileId,
    sessionType: values.sessionType,
    startsAt: startsAt ?? '',
    ...(endsAt ? { endsAt } : {}),
    ...(values.courtId ? { courtId: values.courtId } : {}),
    ...(values.judgeId ? { judgeId: values.judgeId } : {}),
    ...(trimmed(values.courtRoom) ? { courtRoom: trimmed(values.courtRoom) } : {}),
    attendingLawyerId: values.attendingLawyerId ?? '',
    ...(values.reminderDays?.length ? { reminderDays: values.reminderDays } : {}),
  };
}

/** The form of an existing session. */
export function formValuesOf(session: Session, timeZone: string): SessionFormValues {
  const start = pickerValue(session.startsAt, timeZone);
  return {
    sessionType: session.sessionType,
    date: start,
    startsAt: start,
    endsAt: session.endsAt ? pickerValue(session.endsAt, timeZone) : null,
    courtId: session.court?.id ?? null,
    judgeId: session.judge?.id ?? null,
    courtRoom: session.courtRoom ?? '',
    attendingLawyerId: session.attendingLawyer.id,
    reminderDays: [...session.reminderDays],
  };
}

const sameDays = (a: readonly number[], b: readonly number[]) =>
  a.length === b.length && a.every((day) => b.includes(day));

const SLOT_FIELDS = [
  'sessionType',
  'startsAt',
  'endsAt',
  'courtId',
  'judgeId',
  'courtRoom',
  'attendingLawyerId',
] as const;
type Slot = Record<(typeof SLOT_FIELDS)[number], string | null>;

const slotOfSession = (session: Session): Slot => ({
  sessionType: session.sessionType,
  startsAt: session.startsAt,
  endsAt: session.endsAt,
  courtId: session.court?.id ?? null,
  judgeId: session.judge?.id ?? null,
  courtRoom: session.courtRoom,
  attendingLawyerId: session.attendingLawyer.id,
});

function slotOfForm(values: SessionFormValues, timeZone: string, before: Slot): Slot {
  const { startsAt, endsAt = null } = formTimes(values, timeZone);
  return {
    sessionType: values.sessionType,
    startsAt: startsAt ?? before.startsAt,
    endsAt,
    courtId: values.courtId ?? null,
    judgeId: values.judgeId ?? null,
    courtRoom: trimmed(values.courtRoom) ?? null,
    attendingLawyerId: values.attendingLawyerId ?? before.attendingLawyerId,
  };
}

/** Instants are compared as instants (`+02:00` and `Z` may name the same moment), the rest as values. */
const sameValue = (field: keyof Slot, a: string | null, b: string | null) =>
  field === 'startsAt' || field === 'endsAt'
    ? (a === null ? null : Date.parse(a)) === (b === null ? null : Date.parse(b))
    : a === b;

/** `PATCH /sessions/:id`: only the fields whose value changed (reminder days compared as sets). */
export function changesOf(
  session: Session,
  values: SessionFormValues,
  timeZone: string,
): UpdateSessionBody {
  const before = slotOfSession(session);
  const after = slotOfForm(values, timeZone, before);
  const changes: Record<string, unknown> = Object.fromEntries(
    SLOT_FIELDS.filter((field) => !sameValue(field, before[field], after[field])).map((field) => [
      field,
      after[field],
    ]),
  );
  if (values.reminderDays && !sameDays(values.reminderDays, session.reminderDays)) {
    changes['reminderDays'] = values.reminderDays;
  }
  return changes as UpdateSessionBody;
}

/** One busy slot of a 409 BIZ-004: another file's hearing shows only its time when the user cannot see that file. */
export interface Conflict {
  readonly sessionId: string | null;
  readonly startsAt: string;
  readonly fileNumber: string | null;
}

export function conflictsOf(error: unknown): Conflict[] | null {
  if (!isApiError(error) || error.code !== 'BIZ-004') return null;
  return (error.details ?? []).flatMap(({ params }) => {
    return params?.['startsAt']
      ? [
          {
            sessionId: params['sessionId'] ?? null,
            startsAt: params['startsAt'],
            fileNumber: params['fileNumber'] ?? null,
          },
        ]
      : [];
  });
}

/** Whether the hearing has started, so its outcome can be recorded (the API refuses it before). */
export const hasStarted = (session: Pick<SessionListItem, 'startsAt'>, now = Date.now()) =>
  Date.parse(session.startsAt) <= now;
