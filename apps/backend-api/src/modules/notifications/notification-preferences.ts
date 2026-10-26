import { NOTIFICATION_CATEGORIES } from '@nexlegtiq/shared-types';
import type { NotificationCategory, NotificationChannel } from '@nexlegtiq/shared-types';
import { z } from 'zod';

/** The category each notification type belongs to (D-146); a type not listed is always delivered. */
export const CATEGORY_OF_TYPE: Readonly<Record<string, NotificationCategory>> = {
  'task.assigned': 'TASKS',
  SESSION_REMINDER: 'HEARINGS',
  'file.reassigned': 'FILES',
  'file.teamAdded': 'FILES',
  'invitation.accepted': 'TEAM',
  DOCUMENT_QUARANTINED: 'DOCUMENTS',
  DOCUMENT_FAILED: 'DOCUMENTS',
};

/** `users.notification_prefs`: channels turned off per category; anything unreadable counts as "all on". */
export const NotificationPrefsSchema = z
  .partialRecord(
    z.enum(NOTIFICATION_CATEGORIES),
    z.object({ email: z.boolean().optional(), inApp: z.boolean().optional() }),
  )
  .catch({});
export type NotificationPrefs = z.infer<typeof NotificationPrefsSchema>;

/** Does a user with these preferences want this notification type on this channel? On unless turned off. */
export function wants(prefs: unknown, type: string, channel: NotificationChannel): boolean {
  const category = CATEGORY_OF_TYPE[type];
  if (!category) return true;
  return NotificationPrefsSchema.parse(prefs)[category]?.[channel] !== false;
}

interface UserReader {
  user: {
    findMany(args: {
      where: { id: { in: string[] } };
      select: { id: true; notificationPrefs: true };
    }): Promise<{ id: string; notificationPrefs: unknown }[]>;
  };
}

/**
 * Of these recipients, those who want the notification type on the channel — one query, in the caller's client or
 * transaction (scoped: the office's own users only).
 */
export async function recipientsWanting(
  client: UserReader,
  userIds: readonly string[],
  type: string,
  channel: NotificationChannel,
): Promise<Set<string>> {
  if (userIds.length === 0 || !CATEGORY_OF_TYPE[type]) return new Set(userIds);
  const users = await client.user.findMany({
    where: { id: { in: [...userIds] } },
    select: { id: true, notificationPrefs: true },
  });
  const prefs = new Map(users.map((u) => [u.id, u.notificationPrefs]));
  // A recipient not found (it cannot be: the notification's foreign key needs the user) keeps the defaults.
  return new Set(userIds.filter((id) => wants(prefs.get(id) ?? {}, type, channel)));
}
