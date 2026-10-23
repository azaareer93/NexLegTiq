import type { RouteObject } from 'react-router';

/** The pages under `/tasks` (inside the menu item's permission guard): My tasks. */
export const tasksRoutes: RouteObject[] = [
  {
    index: true,
    lazy: async () => ({ Component: (await import('./pages/MyTasksPage')).MyTasksPage }),
  },
];
