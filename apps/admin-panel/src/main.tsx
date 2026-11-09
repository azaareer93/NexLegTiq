import { NexProvider } from '@nexlegtiq/shared-ui';
import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';

import { createAppRouter } from './app/router';
import { queryClient, restoreSession } from './features/auth';

const container = document.getElementById('root');
if (!container) throw new Error('Root element #root not found');

// Once per page load, not in an effect (StrictMode would rotate the refresh cookie twice).
void restoreSession();

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <NexProvider>
        <RouterProvider router={createAppRouter()} />
      </NexProvider>
    </QueryClientProvider>
  </StrictMode>,
);
