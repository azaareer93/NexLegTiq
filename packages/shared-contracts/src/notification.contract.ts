import { NOTIFICATION_TYPES } from '@nexlegtiq/shared-types';
import { z } from 'zod';

/**
 * `GET /notifications` (D-149): the caller's own notifications, newest first, by cursor (api-conventions.md) — `cursor` is
 * the `nextCursor` of the previous page. `unread=true` keeps the unread ones.
 */
export const NotificationQuerySchema = z.object({
  cursor: z.uuid().optional(),
  unread: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type NotificationQuery = z.infer<typeof NotificationQuerySchema>;

/** One notification: the UI renders `titleKey` with `params` in the reader's language; `link` is an office-app path. */
export const NotificationSchema = z.object({
  id: z.uuid(),
  type: z.enum(NOTIFICATION_TYPES),
  titleKey: z.string(),
  params: z.record(z.string(), z.union([z.string(), z.number(), z.null()])),
  link: z.string().nullable(),
  readAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type Notification = z.infer<typeof NotificationSchema>;

export const NotificationPageSchema = z.object({
  items: z.array(NotificationSchema),
  /** Pass as `cursor` for the next page; null on the last page. */
  nextCursor: z.uuid().nullable(),
});
export type NotificationPage = z.infer<typeof NotificationPageSchema>;

/** `GET /notifications/unread-count` and the answer of `POST /notifications/read-all` (`count` = rows marked). */
export const NotificationCountSchema = z.object({ count: z.number().int().nonnegative() });
export type NotificationCount = z.infer<typeof NotificationCountSchema>;
