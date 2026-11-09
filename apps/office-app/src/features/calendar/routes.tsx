import type { RouteObject } from 'react-router';

/** `/calendar` (inside the menu item's `view:assigned:cases` guard, D-091). */
export const calendarRoutes: RouteObject[] = [
  {
    index: true,
    lazy: async () => ({ Component: (await import('./CalendarPage')).CalendarPage }),
  },
];
