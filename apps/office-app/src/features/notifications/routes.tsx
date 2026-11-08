import type { RouteObject } from 'react-router';

/** The page under `/notifications`: every signed-in user's own notifications (D-149). */
export const notificationsRoutes: RouteObject[] = [
  {
    index: true,
    lazy: async () => ({
      Component: (await import('./pages/NotificationsPage')).NotificationsPage,
    }),
  },
];
