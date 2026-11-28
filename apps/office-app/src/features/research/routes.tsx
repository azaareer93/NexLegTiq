import type { RouteObject } from 'react-router';

/** The pages under `/research` (inside the menu item's `use:ai` guard): legal research (D-256). */
export const researchRoutes: RouteObject[] = [
  {
    index: true,
    lazy: async () => ({
      Component: (await import('./pages/LegalResearchPage')).LegalResearchPage,
    }),
  },
];
