import type { RouteObject } from 'react-router';

/** The dashboard at `/` (inside the menu item's `view:assigned:cases` guard, D-091). */
export const dashboardRoutes: RouteObject[] = [
  {
    index: true,
    lazy: async () => ({ Component: (await import('./pages/DashboardPage')).DashboardPage }),
  },
];
