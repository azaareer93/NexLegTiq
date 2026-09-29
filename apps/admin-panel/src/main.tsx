import { DirectionRoot } from '@nexlegtiq/shared-ui';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';

import { createAppRouter } from './app/router';

const container = document.getElementById('root');
if (!container) throw new Error('Root element #root not found');

// Arabic is the default UI language (frontend.md). The LanguageProvider (MVP-44) replaces this with the user's locale.
createRoot(container).render(
  <StrictMode>
    <DirectionRoot locale="ar">
      <RouterProvider router={createAppRouter()} />
    </DirectionRoot>
  </StrictMode>,
);
