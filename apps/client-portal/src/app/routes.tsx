import { Navigate } from 'react-router';
import type { RouteObject } from 'react-router';

import { authRoutes, RequireClient } from '../features/auth';

export const routes: RouteObject[] = [
  ...authRoutes,
  {
    element: <RequireClient />,
    children: [
      {
        path: '/',
        lazy: async () => ({
          Component: (await import('../features/shell/PortalShell')).PortalShell,
        }),
        children: [
          {
            index: true,
            lazy: async () => ({
              Component: (await import('../features/files/pages/FilesListPage')).FilesListPage,
            }),
          },
          {
            path: 'files/:id',
            lazy: async () => ({
              Component: (await import('../features/files/pages/FileDetailPage')).FileDetailPage,
            }),
          },
          {
            path: 'invoices',
            lazy: async () => ({
              Component: (await import('../features/invoices/pages/InvoicesPage')).InvoicesPage,
            }),
          },
          { path: '*', element: <Navigate to="/" replace /> },
        ],
      },
    ],
  },
];
