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
