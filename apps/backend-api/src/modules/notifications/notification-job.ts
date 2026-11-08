import { isAppPath } from '@nexlegtiq/shared-contracts';
import { NOTIFICATION_TYPES } from '@nexlegtiq/shared-types';
import { z } from 'zod';

/** One notification for several users of the job's office (`notification` queue, D-149). */
export const FAN_OUT_NOTIFICATION_JOB = 'fan-out-notification';
/** Daily retention (D-149): a platform job without an office. */
export const PURGE_NOTIFICATIONS_JOB = 'purge-notifications';
export const NOTIFICATION_RETENTION_DAYS = 90;
/** Users per fan-out job; `notify` splits larger lists. */
export const MAX_RECIPIENTS = 500;

/**
 * What a notification says: the UI renders `titleKey` (an i18n key) with `params` in the reader's language; `link` is an
 * office-app path (never another site).
 */
export const NotificationContentSchema = z.object({
  type: z.enum(NOTIFICATION_TYPES),
  titleKey: z.string().regex(/^[a-z][A-Za-z0-9.]{1,199}$/),
  params: z.record(z.string(), z.union([z.string().max(500), z.number(), z.null()])),
  link: z.string().refine(isAppPath).nullable(),
});
export type NotificationContent = z.infer<typeof NotificationContentSchema>;

export const FanOutNotificationJobSchema = NotificationContentSchema.extend({
  userIds: z.array(z.uuid()).min(1).max(MAX_RECIPIENTS),
});
export type FanOutNotificationJob = z.infer<typeof FanOutNotificationJobSchema>;
