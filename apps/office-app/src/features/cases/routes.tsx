import type { RouteObject } from 'react-router';

/**
 * The pages under `/cases` (inside the menu item's permission guard). The file page is a placeholder until the legal-file
 * page story builds it, so a row's link already has somewhere to go.
 */
export const casesRoutes: RouteObject[] = [
  {
    index: true,
    lazy: async () => ({ Component: (await import('./pages/CasesListPage')).CasesListPage }),
  },
  {
    path: ':id',
    lazy: async () => {
      const { PlaceholderPage } = await import('../shell/components/placeholder-page');
      return { Component: () => <PlaceholderPage navKey="cases" /> };
    },
  },
];
