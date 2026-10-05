import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';

import { AppRoot } from './app/app-root';
import { createAppRouter } from './app/router';
import { restoreSession } from './features/auth';

const container = document.getElementById('root');
if (!container) throw new Error('Root element #root not found');

// Once per page load (not in an effect, which StrictMode would run twice): rotating the refresh cookie twice in a row
// is harmless but wasteful.
void restoreSession();

createRoot(container).render(
  <StrictMode>
    <AppRoot>
      <RouterProvider router={createAppRouter()} />
    </AppRoot>
  </StrictMode>,
);
