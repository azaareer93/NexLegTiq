import type { RouteObject } from 'react-router';

/** The pages under `/settings` (inside the menu item's `manage:office` guard, D-091). */
export const settingsRoutes: RouteObject[] = [
  {
    index: true,
    lazy: async () => ({ Component: (await import('./pages/SettingsPage')).SettingsPage }),
  },
];
