/** How numbers are written on screen (D-092, D-146). Mirrors the Prisma enum; labels: `enums.digitStyle.<VALUE>`. */
export const DIGIT_STYLES = ['WESTERN', 'ARABIC_INDIC'] as const;
export type DigitStyle = (typeof DIGIT_STYLES)[number];

/**
 * What a user can switch notifications off for, channel by channel (D-146); labels: `enums.notificationCategory.<VALUE>`.
 * Hearing reminders and the daily task email (D-177) also go by email.
 */
export const NOTIFICATION_CATEGORIES = ['TASKS', 'HEARINGS', 'FILES', 'TEAM', 'DOCUMENTS'] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export const NOTIFICATION_CHANNELS = ['email', 'inApp'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/** The categories that have an email at all; for the others only the in-app switch means something. */
export const EMAIL_CATEGORIES: readonly NotificationCategory[] = ['TASKS', 'HEARINGS'];

/**
 * Every kind of in-app notification (D-149). The text is the row's `titleKey` with its params, so the types have no labels
 * of their own; `CLIENT_UPLOAD` and `CONFLICT_DETECTED` are reserved for the stories that produce them.
 */
export const NOTIFICATION_TYPES = [
  'HEARING_REMINDER',
  'TASK_ASSIGNED',
  'TASK_DUE',
  'DOCUMENT_PROCESSED',
  'DOCUMENT_FAILED',
  'DOCUMENT_QUARANTINED',
  'AI_SUMMARY_READY',
  'INVITE_ACCEPTED',
  'FILE_REASSIGNED',
  'FILE_TEAM_ADDED',
  'CONFLICT_DETECTED',
  'CLIENT_UPLOAD',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];
