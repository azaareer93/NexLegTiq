import type { RouteObject } from 'react-router';

import { GuestOnly } from './components/guards';

/** Public auth pages, lazy-loaded. Reset and verify links work whether or not someone is signed in. */
export const authRoutes: RouteObject[] = [
  {
    element: <GuestOnly />,
    children: [
      { path: '/login', lazy: async () => ({ Component: (await import('./pages/LoginPage')).LoginPage }) },
      { path: '/signup', lazy: async () => ({ Component: (await import('./pages/SignupPage')).SignupPage }) },
      { path: '/forgot-password', lazy: async () => ({ Component: (await import('./pages/ForgotPasswordPage')).ForgotPasswordPage }) },
    ],
  },
  { path: '/reset-password', lazy: async () => ({ Component: (await import('./pages/ResetPasswordPage')).ResetPasswordPage }) },
  { path: '/verify-email', lazy: async () => ({ Component: (await import('./pages/VerifyEmailPage')).VerifyEmailPage }) },
];
