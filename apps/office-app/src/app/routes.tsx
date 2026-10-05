import type { RouteObject } from 'react-router';

import { authRoutes, RequireAuth } from '../features/auth';
import { HomePage } from './home-page';

export const routes: RouteObject[] = [
  ...authRoutes,
  // Everything else needs a signed-in user; the app shell (MVP-45) will wrap these.
  { element: <RequireAuth />, children: [{ path: '/', element: <HomePage /> }] },
];
