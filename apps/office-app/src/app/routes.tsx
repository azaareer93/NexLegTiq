import type { Permission } from '@nexlegtiq/shared-types';
import { LoadingSkeleton } from '@nexlegtiq/shared-ui';
import type { RouteObject } from 'react-router';

import { authRoutes, RequireAuth } from '../features/auth';
import { AppShell, NotFoundPage, RequirePermission, RouteError } from '../features/shell';
import type { NavKey } from '../features/shell/nav';

/** A lazy placeholder page for a menu item, until its feature replaces it. */
const placeholder = (navKey: NavKey | 'profile'): Pick<RouteObject, 'lazy'> => ({
  lazy: async () => {
    const { PlaceholderPage } = await import('../features/shell/components/pages');
    return { Component: () => <PlaceholderPage navKey={navKey} /> };
  },
});

/** A page behind a permission: the 403 page for roles without it (D-051, D-091). */
const guarded = (perform: Permission, navKey: NavKey): RouteObject => ({
  path: navKey,
  element: <RequirePermission perform={perform} />,
  children: [{ index: true, ...placeholder(navKey) }],
});

export const routes: RouteObject[] = [
  {
    // Shown while the first lazy route loads; a route that fails to load (chunk gone after a deploy, offline) offers a reload.
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
              { index: true, ...placeholder('dashboard') },
              { path: 'cases', ...placeholder('cases') },
              guarded('manage:clients', 'clients'),
              { path: 'calendar', ...placeholder('calendar') },
              { path: 'tasks', ...placeholder('tasks') },
              { path: 'documents', ...placeholder('documents') },
              guarded('view:reports', 'reports'),
              guarded('manage:users', 'team'),
              guarded('manage:office', 'settings'),
              { path: 'profile', ...placeholder('profile') },
              { path: '*', element: <NotFoundPage /> },
            ],
          },
        ],
      },
    ],
  },
];
