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
      },
    ],
  },
];
