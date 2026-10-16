/** Kinds of court session (domain-model.md#courts--hearings). Mirrors the Prisma enum; labels: `enums.sessionType.<VALUE>`. */
export const SESSION_TYPES = [
  'HEARING',
  'MEDIATION',
  'ARBITRATION',
  'PRE_TRIAL',
  'STATUS_CONFERENCE',
  'APPEAL_HEARING',
  'JUDGMENT_PRONOUNCEMENT',
] as const;
export type SessionType = (typeof SESSION_TYPES)[number];

/** What came of a session. Mirrors the Prisma enum; labels: `enums.sessionOutcome.<VALUE>`. */
export const SESSION_OUTCOMES = [
  'ADJOURNED',
  'DECIDED',
  'SETTLED',
  'DISMISSED',
  'POSTPONED',
] as const;
export type SessionOutcome = (typeof SESSION_OUTCOMES)[number];

/**
 * Derived, not stored (D-116): CANCELLED when cancelled, COMPLETED once an outcome is recorded, else SCHEDULED.
 * Labels: `enums.sessionStatus.<VALUE>`.
 */
export const SESSION_STATUSES = ['SCHEDULED', 'COMPLETED', 'CANCELLED'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/** State of one hearing reminder (D-036, D-117). Mirrors the Prisma enum; labels: `enums.reminderStatus.<VALUE>`. */
export const REMINDER_STATUSES = ['PENDING', 'SENT', 'FAILED', 'CANCELLED'] as const;
export type ReminderStatus = (typeof REMINDER_STATUSES)[number];
