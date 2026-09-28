import { createBrowserRouter } from 'react-router';

import { routes } from './routes';

export function createAppRouter(): ReturnType<typeof createBrowserRouter> {
  return createBrowserRouter(routes);
}
