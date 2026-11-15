import { Navigate } from 'react-router';
import type { RouteObject } from 'react-router';

import { authRoutes, RequireAdmin } from '../features/auth';

export const routes: RouteObject[] = [
  ...authRoutes,
  {
    element: <RequireAdmin />,
    children: [
      {
        path: '/',
        lazy: async () => ({ Component: (await import('../features/home/HomePage')).HomePage }),
        children: [
          { index: true, element: <Navigate to="/offices" replace /> },
          {
            path: 'offices',
            lazy: async () => ({
              Component: (await import('../features/offices/pages/OfficesListPage'))
                .OfficesListPage,
            }),
          },
          {
            path: 'plans',
            lazy: async () => ({
              Component: (await import('../features/plans/pages/PlansPage')).PlansPage,
            }),
          },
          {
            path: 'usage',
            lazy: async () => ({
              Component: (await import('../features/usage/pages/UsagePage')).UsagePage,
            }),
          },
          {
            path: 'queues',
            lazy: async () => ({
              Component: (await import('../features/usage/pages/QueuesPage')).QueuesPage,
            }),
          },
          {
            path: 'audit',
            lazy: async () => ({
              Component: (await import('../features/usage/pages/PlatformAuditPage'))
                .PlatformAuditPage,
            }),
          },
          {
            path: 'offices/:id',
            lazy: async () => ({
              Component: (await import('../features/offices/pages/OfficeDetailPage'))
                .OfficeDetailPage,
            }),
          },
        ],
      },
    ],
  },
];
