import type { Locale } from '@nexlegtiq/shared-types';
import { LANGUAGE_STORAGE_KEY, NexProvider } from '@nexlegtiq/shared-ui';
import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { HttpResponse } from 'msw';
import type { JsonBodyType } from 'msw';
import { createMemoryRouter, RouterProvider } from 'react-router';

import { routes } from '../app/routes';
import { API_URL, queryClient, restoreSession } from '../features/auth/session';

export const api = (path: string) => `${API_URL}/api/v1/${path}`;
const meta = { timestamp: '2026-11-21T10:00:00.000Z', requestId: 'req-12345678' };
export const ok = (data: JsonBodyType = null, status = 200) =>
  HttpResponse.json({ success: true, data, meta }, { status });
export const fail = (status: number, code: string) =>
  HttpResponse.json({ success: false, error: { code, message: `dev ${code}` }, meta }, { status });

export const OFFICE_ID = '01920000-0000-7000-8000-00000000000a';
export const FILE_ID = '01920000-0000-7000-8000-000000000101';
export const USER = {
  id: '01920000-0000-7000-8000-000000000009',
  fullName: 'Layla Haddad',
  email: 'layla@example.test',
  offices: [
    {
      officeId: OFFICE_ID,
      officeName: 'مكتب العدالة',
      officePhone: '+970 2 295 0000',
      officeEmail: 'office@example.test',
      clientId: '01920000-0000-7000-8000-00000000000c',
      clientName: 'Layla Haddad',
    },
  ],
};
export const SESSION = { accessToken: 'portal-access', expiresIn: 900, user: USER };

export const type = (testId: string, value: string) =>
  fireEvent.change(screen.getByTestId(testId), { target: { value } });
export const click = (testId: string) => fireEvent.click(screen.getByTestId(testId));

/** A fresh page load at `path`, in `locale` (Arabic by default, as for a client). */
export async function renderApp(path = '/', locale: Locale = 'ar') {
  localStorage.setItem(LANGUAGE_STORAGE_KEY, locale);
  await restoreSession();
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <QueryClientProvider client={queryClient}>
      <NexProvider>
        <RouterProvider router={router} />
      </NexProvider>
    </QueryClientProvider>,
  );
  return router;
}

export async function expectAccessible(): Promise<void> {
  const { violations } = await axe.run(document.body, {
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
  });
  expect(violations.map((violation) => violation.id)).toEqual([]);
}
