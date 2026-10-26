import type { RouteObject } from 'react-router';

/** The page under `/profile`: every signed-in user's own account (D-146). */
export const profileRoutes: RouteObject[] = [
  {
    index: true,
    lazy: async () => ({ Component: (await import('./pages/ProfilePage')).ProfilePage }),
  },
];
