import { LanguageProvider } from '@nexlegtiq/shared-ui';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';

import { createAppRouter } from './app/router';

const container = document.getElementById('root');
if (!container) throw new Error('Root element #root not found');

createRoot(container).render(
  <StrictMode>
    <LanguageProvider>
      <RouterProvider router={createAppRouter()} />
    </LanguageProvider>
  </StrictMode>,
);
