import type { RouteObject } from 'react-router';

import { GuestOnly } from './components/guards';

/** Sign-in and enrolment, lazy-loaded; a signed-in admin is sent to the panel. */
export const authRoutes: RouteObject[] = [
  {
    element: <GuestOnly />,
    children: [
      {
        path: '/login',
        lazy: async () => ({ Component: (await import('./pages/LoginPage')).LoginPage }),
      },
      {
        path: '/enroll',
        lazy: async () => ({ Component: (await import('./pages/EnrollPage')).EnrollPage }),
      },
    ],
  },
];
