import { NOTIFICATION_CATEGORIES } from '@nexlegtiq/shared-types';
import type {
  NotificationCategory,
  NotificationChannel,
  NotificationType,
} from '@nexlegtiq/shared-types';
import { z } from 'zod';

/**
 * The category each notification type belongs to (D-146, D-149); `null` = always delivered — the malware alert
 * (`DOCUMENT_QUARANTINED`) is a security notice.
 */
export const CATEGORY_OF_TYPE: Readonly<Record<NotificationType, NotificationCategory | null>> = {
  HEARING_REMINDER: 'HEARINGS',
  TASK_ASSIGNED: 'TASKS',
  TASK_DUE: 'TASKS',
  DOCUMENT_PROCESSED: 'DOCUMENTS',
  DOCUMENT_FAILED: 'DOCUMENTS',
  DOCUMENT_QUARANTINED: null,
  AI_SUMMARY_READY: 'DOCUMENTS',
  INVITE_ACCEPTED: 'TEAM',
  FILE_REASSIGNED: 'FILES',
  FILE_TEAM_ADDED: 'FILES',
  CONFLICT_DETECTED: 'FILES',
  CLIENT_UPLOAD: 'DOCUMENTS',
};

const ChannelsSchema = z.object({ email: z.boolean().optional(), inApp: z.boolean().optional() });
export type NotificationPrefs = Partial<
  Record<NotificationCategory, z.infer<typeof ChannelsSchema>>
>;

/**
 * `users.notification_prefs`: channels turned off per category. Read entry by entry — an unknown category (renamed in a
 * later release) or an unreadable entry is dropped alone, so it never turns the user's other choices back on.
 */
export function readPrefs(stored: unknown): NotificationPrefs {
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return {};
  const prefs: NotificationPrefs = {};
  for (const category of NOTIFICATION_CATEGORIES) {
    const parsed = ChannelsSchema.safeParse((stored as Record<string, unknown>)[category]);
    if (parsed.success) prefs[category] = parsed.data;
  }
  return prefs;
}

/** Does a user with these preferences want this notification type on this channel? On unless turned off. */
export function wants(
  prefs: unknown,
  type: NotificationType,
  channel: NotificationChannel,
): boolean {
  const category = CATEGORY_OF_TYPE[type];
  if (!category) return true;
  return readPrefs(prefs)[category]?.[channel] !== false;
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
  type: NotificationType,
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
