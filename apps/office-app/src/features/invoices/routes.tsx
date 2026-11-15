import type { RouteObject } from 'react-router';

/** The pages under `/invoices` (inside the menu item's permission guard). */
export const invoicesRoutes: RouteObject[] = [
  {
    index: true,
    lazy: async () => ({ Component: (await import('./pages/InvoicesPage')).InvoicesPage }),
  },
];
