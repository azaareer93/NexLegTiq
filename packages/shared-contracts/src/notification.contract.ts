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

/**
 * A notification link is a path of this app: a single leading slash and URL characters only — no whitespace, control
 * characters or backslash, which a browser strips or turns into another site (`/\t/evil.test` → `//evil.test`).
 */
export const APP_PATH_PATTERN = /^\/(?![/\\])[A-Za-z0-9\-._~!$&'()*+,;=:@%/?#]*$/;
export const isAppPath = (value: string): boolean =>
  value.length <= 500 && APP_PATH_PATTERN.test(value);

/** One notification: the UI renders `titleKey` with `params` in the reader's language; `link` is an office-app path. */
export const NotificationSchema = z.object({
  id: z.uuid(),
  /** One of NOTIFICATION_TYPES; read as text, so a type added by a newer server never breaks the list. */
  type: z.string(),
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
