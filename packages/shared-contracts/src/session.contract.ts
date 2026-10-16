import {
  REMINDER_STATUSES,
  SESSION_OUTCOMES,
  SESSION_STATUSES,
  SESSION_TYPES,
} from '@nexlegtiq/shared-types';
import { z } from 'zod';

import { longText, plainText } from './fields.js';

/**
 * An instant with its UTC offset or `Z` (`2026-11-02T09:30:00+02:00`). Stored in UTC; the office app sends the
 * office-time wall clock with its offset and shows answers in the office's time zone (D-092, D-116).
 */
const InstantSchema = z.iso.datetime({ offset: true, message: 'validation.dateTime' });

/** Days before the hearing a reminder is due: 0–365, each once, at most 10. Defaults to the office's setting. */
const ReminderDaysSchema = z
  .array(z.number().int().min(0, 'validation.reminderDays').max(365, 'validation.reminderDays'))
  .max(10, 'validation.tooLong')
  .refine((days) => new Set(days).size === days.length, 'validation.duplicate');

const endsAfterStart = (body: { startsAt?: string; endsAt?: string | null }) =>
  !body.startsAt || !body.endsAt || Date.parse(body.endsAt) > Date.parse(body.startsAt);
const END_ISSUE = { message: 'validation.endsBeforeStart', path: ['endsAt'] };
/** A session lasts at most 24 hours (CHECK `sessions_duration_check`). */
const MAX_SESSION_MS = 24 * 3_600_000;
const notTooLong = (body: { startsAt?: string; endsAt?: string | null }) =>
  !body.startsAt ||
  !body.endsAt ||
  Date.parse(body.endsAt) - Date.parse(body.startsAt) <= MAX_SESSION_MS;
const LENGTH_ISSUE = { message: 'validation.sessionTooLong', path: ['endsAt'] };

const sessionFields = {
  sessionType: z.enum(SESSION_TYPES),
  startsAt: InstantSchema,
  /** Without an end the conflict check counts one hour; at most 24 hours after the start. */
  endsAt: InstantSchema,
  courtId: z.uuid(),
  /** Requires `courtId`: a judge of that court. */
  judgeId: z.uuid(),
  courtRoom: plainText(100),
  /** An active office manager, senior lawyer or lawyer who can see the file. */
  attendingLawyerId: z.uuid(),
  reminderDays: ReminderDaysSchema,
};

/** Overrides the 409 BIZ-004 of an overlapping session of the same attending lawyer (domain-model invariant 5). */
const acknowledgeConflict = z.boolean().default(false);

/** `POST /sessions` (D-116). */
export const CreateSessionSchema = z
  .object({
    fileId: z.uuid(),
    ...sessionFields,
    sessionType: sessionFields.sessionType.default('HEARING'),
    endsAt: sessionFields.endsAt.optional(),
    courtId: sessionFields.courtId.optional(),
    judgeId: sessionFields.judgeId.optional(),
    courtRoom: sessionFields.courtRoom.optional(),
    reminderDays: sessionFields.reminderDays.optional(),
    acknowledgeConflict,
  })
  .refine(endsAfterStart, END_ISSUE)
  .refine(notTooLong, LENGTH_ISSUE)
  .refine((body) => body.judgeId === undefined || body.courtId !== undefined, {
    message: 'validation.unknownJudge',
    path: ['judgeId'],
  });
export type CreateSessionRequest = z.infer<typeof CreateSessionSchema>;

/**
 * `PATCH /sessions/:id` — only while the session is scheduled (BIZ-012 otherwise). `null` clears an optional field; a
 * new time or attending lawyer re-runs the conflict check; a new time moves the pending reminders.
 */
export const UpdateSessionSchema = z
  .object({
    ...sessionFields,
    endsAt: sessionFields.endsAt.nullable(),
    courtId: sessionFields.courtId.nullable(),
    judgeId: sessionFields.judgeId.nullable(),
    courtRoom: sessionFields.courtRoom.nullable(),
  })
  .partial()
  .extend({ acknowledgeConflict })
  .refine(
    ({ acknowledgeConflict: _ack, ...body }) => Object.keys(body).length > 0,
    'validation.required',
  )
  .refine(endsAfterStart, END_ISSUE)
  .refine(notTooLong, LENGTH_ISSUE);
export type UpdateSessionRequest = z.infer<typeof UpdateSessionSchema>;

/** `POST /sessions/:id/cancel`: cancels the session and its pending reminders. */
export const CancelSessionSchema = z.object({ reason: plainText(500).optional() });
export type CancelSessionRequest = z.infer<typeof CancelSessionSchema>;

/**
 * The session a hearing was adjourned to. Court, judge, room, type and attending lawyer default to the current
 * session's; it must start after it.
 */
export const NextSessionSchema = z
  .object({
    ...sessionFields,
    sessionType: sessionFields.sessionType.optional(),
    endsAt: sessionFields.endsAt.optional(),
    courtId: sessionFields.courtId.nullable().optional(),
    judgeId: sessionFields.judgeId.nullable().optional(),
    courtRoom: sessionFields.courtRoom.nullable().optional(),
    attendingLawyerId: sessionFields.attendingLawyerId.optional(),
    reminderDays: sessionFields.reminderDays.optional(),
    acknowledgeConflict,
  })
  .refine(endsAfterStart, END_ISSUE)
  .refine(notTooLong, LENGTH_ISSUE);

/**
 * `POST /sessions/:id/outcome`: records (or corrects) what happened; only once the session has started and while it is
 * not cancelled. `nextSession` creates the next hearing and links it (once).
 */
export const SessionOutcomeSchema = z.object({
  outcome: z.enum(SESSION_OUTCOMES),
  minutes: longText(20_000).optional(),
  nextSession: NextSessionSchema.optional(),
});
export type SessionOutcomeRequest = z.infer<typeof SessionOutcomeSchema>;

/** At most 92 days per calendar query (a quarter: month and agenda views). */
const MAX_RANGE_MS = 92 * 86_400_000;

/**
 * `GET /sessions` — the calendar. `from` defaults to now and `to` to 31 days after `from`; sessions starting in
 * [from, to) on files the caller can see, ordered by start. `lawyerId=me` is the caller.
 */
export const SessionQuerySchema = z
  .object({
    from: InstantSchema.optional(),
    to: InstantSchema.optional(),
    lawyerId: z.union([z.literal('me'), z.uuid()]).optional(),
    fileId: z.uuid().optional(),
  })
  .refine(
    ({ from, to }) => {
      if (!to) return true;
      const start = from ? Date.parse(from) : Date.now();
      const end = Date.parse(to);
      return end > start && end - start <= MAX_RANGE_MS;
    },
    { message: 'validation.dateRange', path: ['to'] },
  );
export type SessionQuery = z.infer<typeof SessionQuerySchema>;

/** `GET /cases/:id/sessions`: upcoming (soonest first) or past (latest first), paginated. */
export const FileSessionsQuerySchema = z.object({
  when: z.enum(['upcoming', 'past']).default('upcoming'),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type FileSessionsQuery = z.infer<typeof FileSessionsQuerySchema>;

const PersonSchema = z.object({ id: z.uuid(), fullName: z.string() });

/**
 * One reminder of a session for one recipient (D-117): due at 09:00 office time `daysBefore` days ahead, then SENT (email and
 * in-app notification handed over) or FAILED; CANCELLED when the session moved, was cancelled or held. Acknowledged by its
 * recipient (`POST /sessions/reminders/:id/ack`).
 */
export const SessionReminderSchema = z.object({
  id: z.uuid(),
  daysBefore: z.number().int(),
  scheduledFor: z.iso.datetime(),
  status: z.enum(REMINDER_STATUSES),
  recipient: PersonSchema,
  sentAt: z.iso.datetime().nullable(),
  acknowledgedAt: z.iso.datetime().nullable(),
});
export type SessionReminder = z.infer<typeof SessionReminderSchema>;

/** A session alone, with its reminders (oldest due first). Instants are UTC (`Z`). */
export const SessionSchema = z.object({
  id: z.uuid(),
  file: z.object({ id: z.uuid(), fileNumber: z.string(), title: z.string() }),
  sessionType: z.enum(SESSION_TYPES),
  status: z.enum(SESSION_STATUSES),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime().nullable(),
  court: z.object({ id: z.uuid(), nameAr: z.string(), nameEn: z.string().nullable() }).nullable(),
  judge: PersonSchema.nullable(),
  courtRoom: z.string().nullable(),
  attendingLawyer: PersonSchema,
  reminderDays: z.array(z.number().int()),
  outcome: z.enum(SESSION_OUTCOMES).nullable(),
  minutes: z.string().nullable(),
  nextSessionId: z.uuid().nullable(),
  previousSessionId: z.uuid().nullable(),
  cancellationReason: z.string().nullable(),
  reminders: z.array(SessionReminderSchema),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Session = z.infer<typeof SessionSchema>;

/** A session in the calendar and a file's list: without the minutes (up to 20,000 characters each) and reminders. */
export const SessionListItemSchema = SessionSchema.omit({ minutes: true, reminders: true });
export type SessionListItem = z.infer<typeof SessionListItemSchema>;
