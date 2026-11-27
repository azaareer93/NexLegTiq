import type { Locale } from '@nexlegtiq/shared-types';
import { LANGUAGE_STORAGE_KEY, NexProvider } from '@nexlegtiq/shared-ui';
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { createMemoryRouter, RouterProvider } from 'react-router';

import { routes } from '../../app/routes';
import { API_URL, queryClient, resetSession, useAdminSession } from '../auth/session';

const api = (path: string) => `${API_URL}/api/v1/${path}`;
const meta = { timestamp: '2026-11-28T10:00:00.000Z', requestId: 'req-12345678' };
const ok = (data: unknown, status = 200) =>
  HttpResponse.json({ success: true, data, meta }, { status });

const SUB = {
  id: '01920000-0000-7000-8000-0000000000c2',
  nameAr: 'عمالي',
  nameEn: 'Labour',
  sortOrder: 0,
  isActive: true,
  updatedAt: '2026-11-28T10:00:00.000Z',
};
const TYPE = {
  id: '01920000-0000-7000-8000-0000000000c1',
  jurisdiction: 'PALESTINE',
  code: 'LITIGATION',
  numberCode: 'LIT',
  nameAr: 'تقاضٍ',
  nameEn: 'Litigation',
  sortOrder: 10,
  isActive: true,
  subTypes: [SUB],
  updatedAt: '2026-11-28T10:00:00.000Z',
};

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  resetSession();
  localStorage.clear();
});
afterAll(() => server.close());

/** Serves the list per country and records every write as `METHOD path body`. */
function serve(): { countries: string[]; writes: string[] } {
  const calls = { countries: [] as string[], writes: [] as string[] };
  const record = async (request: Request) => {
    calls.writes.push(`${request.method} ${new URL(request.url).pathname} ${await request.text()}`);
    return ok(TYPE, request.method === 'POST' ? 201 : 200);
  };
  server.use(
    http.get(api('admin/file-types'), ({ request }) => {
      const country = new URL(request.url).searchParams.get('jurisdiction') ?? '';
      calls.countries.push(country);
      return ok(country === 'PALESTINE' ? [TYPE] : []);
    }),
    http.post(api('admin/file-types'), ({ request }) => record(request)),
    http.patch(api(`admin/file-types/${TYPE.id}`), ({ request }) => record(request)),
    http.post(api(`admin/file-types/${TYPE.id}/sub-types`), ({ request }) => record(request)),
    http.patch(api(`admin/file-sub-types/${SUB.id}`), ({ request }) => record(request)),
  );
  return calls;
}

function renderPage(locale: Locale = 'en') {
  localStorage.setItem(LANGUAGE_STORAGE_KEY, locale);
  useAdminSession.setState({
    status: 'authenticated',
    accessToken: 'admin-access',
    admin: { id: TYPE.id, fullName: 'Founder', email: 'founder@example.test' },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <NexProvider>
        <RouterProvider router={createMemoryRouter(routes, { initialEntries: ['/file-types'] })} />
      </NexProvider>
    </QueryClientProvider>,
  );
}

const type = (testId: string, value: string) =>
  fireEvent.change(screen.getByTestId(testId), { target: { value } });
const path = `/api/v1/admin/file-types`;

describe('file types page (D-261)', () => {
  it(
    'should create a type in the chosen country with its fixed codes',
    { timeout: 30_000 },
    async () => {
      const calls = serve();
      renderPage();
      const table = await screen.findByTestId('file-types-table');
      expect(table.textContent).toContain('LITIGATION');
      expect(table.textContent).toContain('Litigation');
      fireEvent.click(screen.getByTestId('file-type-new'));
      type('file-type-code', 'FAMILY');
      type('file-type-number', 'FAM');
      type('file-type-name-ar', 'أحوال شخصية');
      type('file-type-name-en', 'Family');
      fireEvent.click(screen.getByTestId('file-type-confirm'));
      await waitFor(() => expect(calls.writes).toHaveLength(1));
      expect(JSON.parse(calls.writes[0]?.split(' ').slice(2).join(' ') ?? '{}')).toEqual({
        code: 'FAMILY',
        numberCode: 'FAM',
        nameAr: 'أحوال شخصية',
        nameEn: 'Family',
        sortOrder: 0,
        isActive: true,
        jurisdiction: 'PALESTINE',
      });
      expect(calls.countries).toContain('PALESTINE');
    },
  );

  it(
    'should deactivate a type sending only what changed, and edit a sub-type',
    { timeout: 30_000 },
    async () => {
      const calls = serve();
      renderPage();
      fireEvent.click(await screen.findByTestId('file-type-edit-LITIGATION'));
      expect(screen.getByTestId('file-type-code').hasAttribute('disabled')).toBe(true);
      fireEvent.click(screen.getByTestId('file-type-active'));
      fireEvent.click(screen.getByTestId('file-type-confirm'));
      await waitFor(() => expect(calls.writes).toHaveLength(1));
      expect(calls.writes[0]).toBe(`PATCH ${path}/${TYPE.id} {"isActive":false}`);

      await waitFor(() => expect(screen.queryByTestId('file-type-confirm')).toBeNull());
      fireEvent.click(screen.getByRole('button', { name: /expand row/i }));
      fireEvent.click(await screen.findByTestId(`file-sub-type-edit-${SUB.id}`));
      type('file-type-name-en', 'Labour law');
      fireEvent.click(screen.getByTestId('file-type-confirm'));
      await waitFor(() => expect(calls.writes).toHaveLength(2));
      expect(calls.writes[1]).toBe(
        `PATCH /api/v1/admin/file-sub-types/${SUB.id} {"nameEn":"Labour law"}`,
      );
    },
  );

  it('should be accessible in Arabic', { timeout: 60_000 }, async () => {
    serve();
    renderPage('ar');
    await screen.findByTestId('file-types-table');
    expect(document.documentElement.dir).toBe('rtl');
    const { violations } = await axe.run(document.body, {
      rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
    });
    expect(violations.map((v) => v.id)).toEqual([]);
  });
});
