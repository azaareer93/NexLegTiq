import type { RouteObject } from 'react-router';

/** The pages under `/cases` (inside the menu item's permission guard): the list and a file's page (D-113, D-118). */
export const casesRoutes: RouteObject[] = [
  {
    index: true,
    lazy: async () => ({ Component: (await import('./pages/CasesListPage')).CasesListPage }),
  },
  {
    path: ':id',
    lazy: async () => ({ Component: (await import('./pages/CasePage')).CasePage }),
  },
];
