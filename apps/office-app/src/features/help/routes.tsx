import type { RouteObject } from 'react-router';

/** `/help` and `/help/:slug` (D-185), for every signed-in user. */
export const helpRoutes: RouteObject[] = [
  { index: true, lazy: async () => ({ Component: (await import('./pages/HelpPage')).HelpPage }) },
  {
    path: ':slug',
    lazy: async () => ({
      Component: (await import('./pages/HelpArticlePage')).HelpArticlePage,
    }),
  },
];
