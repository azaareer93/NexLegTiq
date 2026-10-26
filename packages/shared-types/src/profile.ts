/** How numbers are written on screen (D-092, D-146). Mirrors the Prisma enum; labels: `enums.digitStyle.<VALUE>`. */
export const DIGIT_STYLES = ['WESTERN', 'ARABIC_INDIC'] as const;
export type DigitStyle = (typeof DIGIT_STYLES)[number];

/**
 * What a user can switch notifications off for, channel by channel (D-146); labels: `enums.notificationCategory.<VALUE>`.
 * Only hearing reminders also go by email today.
 */
export const NOTIFICATION_CATEGORIES = ['TASKS', 'HEARINGS', 'FILES', 'TEAM', 'DOCUMENTS'] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export const NOTIFICATION_CHANNELS = ['email', 'inApp'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/** The categories that have an email at all; for the others only the in-app switch means something. */
export const EMAIL_CATEGORIES: readonly NotificationCategory[] = ['HEARINGS'];
