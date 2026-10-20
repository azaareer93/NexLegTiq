import type { RouteObject } from 'react-router';

/** The pages under `/team` (inside the menu item's `manage:users` guard, D-091). */
export const teamRoutes: RouteObject[] = [
  {
    index: true,
    lazy: async () => ({ Component: (await import('./pages/TeamPage')).TeamPage }),
  },
];
