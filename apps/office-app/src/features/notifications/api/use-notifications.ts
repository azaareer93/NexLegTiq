import { notificationsApi } from '@nexlegtiq/shared-api-client';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiClient } from '../../auth';

const notifications = notificationsApi(apiClient);

/** Under `notifications`: the realtime bridge refreshes every query of this prefix on a `notification` event (D-129). */
export const notificationKeys = {
  all: ['notifications'] as const,
  unreadCount: () => [...notificationKeys.all, 'unread-count'] as const,
  latest: () => [...notificationKeys.all, 'latest'] as const,
  pages: (unread: boolean) => [...notificationKeys.all, 'pages', { unread }] as const,
};

/** The bell shows the latest ten (D-149). */
export const BELL_LIMIT = 10;
const PAGE_LIMIT = 20;

export const useUnreadCount = () =>
  useQuery({
    queryKey: notificationKeys.unreadCount(),
    queryFn: ({ signal }) => notifications.unreadCount(signal),
  });

export const useLatestNotifications = (enabled: boolean) =>
  useQuery({
    queryKey: notificationKeys.latest(),
    queryFn: ({ signal }) => notifications.list({ limit: BELL_LIMIT }, signal),
    enabled,
  });

export const useNotificationPages = (unread: boolean) =>
  useInfiniteQuery({
    queryKey: notificationKeys.pages(unread),
    queryFn: ({ pageParam, signal }) =>
      notifications.list(
        {
          limit: PAGE_LIMIT,
          ...(unread ? { unread } : {}),
          ...(pageParam ? { cursor: pageParam } : {}),
        },
        signal,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

/** Marking read refreshes every notification view (count, bell, page). */
function useRefreshAfter<T>(mutationFn: (arg: T) => Promise<unknown>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSettled: () => queryClient.invalidateQueries({ queryKey: notificationKeys.all }),
  });
}

export const useMarkRead = () => useRefreshAfter((id: string) => notifications.markRead(id));
export const useMarkAllRead = () => useRefreshAfter((_: void) => notifications.markAllRead());
