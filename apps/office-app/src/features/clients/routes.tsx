import type { RouteObject } from 'react-router';

/** The pages under `/clients` (inside the menu item's `manage:clients` guard, D-091): the list (D-121) and a client's profile (MVP-55). */
export const clientsRoutes: RouteObject[] = [
  {
    index: true,
    lazy: async () => ({ Component: (await import('./pages/ClientsListPage')).ClientsListPage }),
  },
  {
    path: ':id',
    lazy: async () => ({ Component: (await import('./pages/ClientPage')).ClientPage }),
  },
];
