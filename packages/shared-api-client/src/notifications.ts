import {
  NotificationCountSchema,
  NotificationPageSchema,
  NotificationSchema,
} from '@nexlegtiq/shared-contracts';
import type {
  Notification,
  NotificationCount,
  NotificationPage,
} from '@nexlegtiq/shared-contracts';

import type { ApiClient } from './api-client.js';

/** What `GET /notifications` takes (D-149); `cursor` is the previous page's `nextCursor`. */
export interface NotificationListParams {
  readonly cursor?: string;
  readonly unread?: boolean;
  readonly limit?: number;
}

/** The signed-in user's own notifications (D-149). */
export function notificationsApi(client: ApiClient) {
  return {
    list: (query: NotificationListParams, signal?: AbortSignal): Promise<NotificationPage> =>
      client.request(
        { method: 'GET', path: 'notifications', query: { ...query }, signal },
        NotificationPageSchema,
      ),
    unreadCount: (signal?: AbortSignal): Promise<NotificationCount> =>
      client.request(
        { method: 'GET', path: 'notifications/unread-count', signal },
        NotificationCountSchema,
      ),
    markRead: (id: string): Promise<Notification> =>
      client.request(
        { method: 'POST', path: `notifications/${encodeURIComponent(id)}/read` },
        NotificationSchema,
      ),
    markAllRead: (): Promise<NotificationCount> =>
      client.request({ method: 'POST', path: 'notifications/read-all' }, NotificationCountSchema),
  };
}
