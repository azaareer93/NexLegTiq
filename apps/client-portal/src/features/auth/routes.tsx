import type { RouteObject } from 'react-router';

import { GuestOnly } from './components/guards';

/** Public pages, lazy-loaded. Emailed links (invite, reset) work signed in or not. */
export const authRoutes: RouteObject[] = [
  {
    element: <GuestOnly />,
    children: [
      {
        path: '/login',
        lazy: async () => ({ Component: (await import('./pages/LoginPage')).LoginPage }),
      },
      {
        path: '/forgot-password',
        lazy: async () => ({
          Component: (await import('./pages/ForgotPasswordPage')).ForgotPasswordPage,
        }),
      },
    ],
  },
  {
    path: '/accept-invite',
    lazy: async () => ({ Component: (await import('./pages/AcceptInvitePage')).AcceptInvitePage }),
  },
  {
    path: '/reset-password',
    lazy: async () => ({
      Component: (await import('./pages/ResetPasswordPage')).ResetPasswordPage,
    }),
  },
];
