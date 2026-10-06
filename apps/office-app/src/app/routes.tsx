import { LoadingSkeleton } from '@nexlegtiq/shared-ui';
import type { RouteObject } from 'react-router';

import { authRoutes, RequireAuth } from '../features/auth';
import { AppShell, NAV_ITEMS, NotFoundPage, RequirePermission, RouteError } from '../features/shell';
import type { NavKey } from '../features/shell';

/** A lazy placeholder page, until its feature replaces it (its own chunk: the module is only imported here). */
const placeholder = (navKey: NavKey | 'profile'): Pick<RouteObject, 'lazy'> => ({
  lazy: async () => {
    const { PlaceholderPage } = await import('../features/shell/components/placeholder-page');
    return { Component: () => <PlaceholderPage navKey={navKey} /> };
  },
});

/**
 * One route per menu item, generated from `NAV_ITEMS`: each page requires exactly the permission its menu item does, and
 * shows the 403 page otherwise (D-051, D-091).
 */
const menuRoutes: RouteObject[] = NAV_ITEMS.map((item) => ({
  // The dashboard's guard is a pathless layout around the index page (an index route has no children).
  ...(item.path === '/' ? {} : { path: item.path.slice(1) }),
  element: <RequirePermission perform={item.perform} />,
  children: [{ index: true, ...placeholder(item.key) }],
}));

export const routes: RouteObject[] = [
  {
    // Shown while the first lazy route loads; an error outside the shell (e.g. a sign-in page's chunk) gets the error page.
    HydrateFallback: LoadingSkeleton,
    errorElement: <RouteError />,
    children: [
      ...authRoutes,
      {
        element: <RequireAuth />,
        children: [
          {
            element: <AppShell />,
            children: [
              {
                // Errors of a page stay inside the shell: the menu remains usable.
                errorElement: <RouteError />,
                children: [...menuRoutes, { path: 'profile', ...placeholder('profile') }, { path: '*', element: <NotFoundPage /> }],
              },
            ],
          },
        ],
      },
    ],
  },
];
