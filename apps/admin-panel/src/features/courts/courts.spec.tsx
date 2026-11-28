import type { Locale } from '@nexlegtiq/shared-types';
import { LANGUAGE_STORAGE_KEY, NexProvider } from '@nexlegtiq/shared-ui';
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
const page = (items: unknown[]) =>
  HttpResponse.json({
    success: true,
    data: items,
    meta: {
      ...meta,
      pagination: { page: 1, limit: 20, total: items.length, totalPages: 1, hasMore: false },
    },
  });

const COURT = {
  id: '01920000-0000-7000-8000-0000000000c1',
  jurisdiction: 'PALESTINE',
  courtType: 'MAGISTRATE',
  nameAr: 'محكمة صلح رام الله',
  nameEn: 'Ramallah Magistrate Court',
  city: 'رام الله',
  address: null,
  phone: null,
  email: null,
  isPlatform: true,
  isActive: true,
  createdAt: '2026-11-01T10:00:00.000Z',
  updatedAt: '2026-11-01T10:00:00.000Z',
};
const REPORT = {
  id: '01920000-0000-7000-8000-0000000000d1',
  name: 'محكمة صلح يطا',
  city: 'يطا',
  note: 'غير موجودة',
  status: 'PENDING',
  createdAt: '2026-11-20T10:00:00.000Z',
  officeId: '01920000-0000-7000-8000-0000000000a1',
  officeName: 'مكتب الاختبار',
  jurisdiction: 'PALESTINE',
  reportedByName: 'ليلى',
  courtId: null,
  dismissReason: null,
  resolvedAt: null,
};
const OFFICE_COURT = {
  ...COURT,
  id: '01920000-0000-7000-8000-0000000000e1',
  nameAr: 'محكمة المكتب',
  nameEn: null,
  isPlatform: false,
  officeId: REPORT.officeId,
  officeName: 'مكتب الاختبار',
  fileCount: 3,
  sessionCount: 2,
  judgeCount: 1,
};

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  resetSession();
  queryClient.clear();
  localStorage.clear();
});
afterAll(() => server.close());

function renderCourts(locale: Locale = 'en') {
  localStorage.setItem(LANGUAGE_STORAGE_KEY, locale);
  useAdminSession.setState({
    status: 'authenticated',
    accessToken: 'admin-access',
    admin: { id: COURT.id, fullName: 'Founder', email: 'founder@example.test' },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <NexProvider>
        <RouterProvider router={createMemoryRouter(routes, { initialEntries: ['/courts'] })} />
      </NexProvider>
    </QueryClientProvider>,
  );
}

const type = (testId: string, value: string) =>
  fireEvent.change(screen.getByTestId(testId), { target: { value } });

describe('courts page', () => {
  it('should list a country courts, add one and deactivate one', { timeout: 30_000 }, async () => {
    const queries: string[] = [];
    const posts: unknown[] = [];
    const patches: unknown[] = [];
    server.use(
      http.get(api('admin/courts'), ({ request }) => {
        queries.push(new URL(request.url).searchParams.get('jurisdiction') ?? '');
        return page([COURT]);
      }),
      http.post(api('admin/courts'), async ({ request }) => {
        posts.push(await request.json());
        return ok(COURT, 201);
      }),
      http.patch(api(`admin/courts/${COURT.id}`), async ({ request }) => {
        patches.push(await request.json());
        return ok({ ...COURT, isActive: false });
      }),
    );
    renderCourts();
    const table = await screen.findByTestId('courts-table');
    await waitFor(() => expect(table.textContent).toContain('Ramallah Magistrate Court'));
    expect(table.textContent).toContain('Active');
    expect(queries[0]).toBe('PALESTINE');

    fireEvent.click(screen.getByTestId(`court-toggle-${COURT.id}`));
    await waitFor(() => expect(patches).toEqual([{ isActive: false }]));

    fireEvent.click(screen.getByTestId('court-new'));
    fireEvent.mouseDown(within(await screen.findByRole('dialog')).getByRole('combobox'));
    fireEvent.click(await screen.findByTitle('Magistrate'));
    type('court-name-ar', 'محكمة صلح يطا');
    type('court-name-en', 'Yatta Magistrate Court');
    fireEvent.click(screen.getByTestId('court-confirm'));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({
      jurisdiction: 'PALESTINE',
      courtType: 'MAGISTRATE',
      nameAr: 'محكمة صلح يطا',
      nameEn: 'Yatta Magistrate Court',
    });
  });

  it('should send only the changed fields when editing', async () => {
    const patches: unknown[] = [];
    server.use(
      http.get(api('admin/courts'), () => page([COURT])),
      http.patch(api(`admin/courts/${COURT.id}`), async ({ request }) => {
        patches.push(await request.json());
        return ok(COURT);
      }),
    );
    renderCourts();
    fireEvent.click(await screen.findByTestId(`court-edit-${COURT.id}`));
    type('court-city', '');
    fireEvent.click(screen.getByTestId('court-confirm'));
    await waitFor(() => expect(patches).toEqual([{ city: null }]));
  });

  it(
    'should add a reported court and dismiss another with a reason',
    { timeout: 30_000 },
    async () => {
      const adds: unknown[] = [];
      const dismissals: unknown[] = [];
      const other = { ...REPORT, id: '01920000-0000-7000-8000-0000000000d2', name: 'مكررة' };
      server.use(
        http.get(api('admin/courts'), () => page([COURT])),
        http.get(api('admin/court-reports'), () => page([REPORT, other])),
        http.post(api(`admin/court-reports/${REPORT.id}/add`), async ({ request }) => {
          adds.push(await request.json());
          return ok({ ...REPORT, status: 'ADDED' });
        }),
        http.post(api(`admin/court-reports/${other.id}/dismiss`), async ({ request }) => {
          dismissals.push(await request.json());
          return ok({ ...other, status: 'DISMISSED' });
        }),
      );
      renderCourts();
      fireEvent.click(await screen.findByTestId('tab-reports'));
      const table = await screen.findByTestId('reports-table');
      await waitFor(() => expect(table.textContent).toContain('مكتب الاختبار'));

      fireEvent.click(screen.getByTestId(`report-add-${REPORT.id}`));
      fireEvent.mouseDown(within(await screen.findByRole('dialog')).getByRole('combobox'));
      fireEvent.click(await screen.findByTitle('Magistrate'));
      type('court-name-en', 'Yatta Magistrate Court');
      fireEvent.click(screen.getByTestId('court-confirm'));
      await waitFor(() => expect(adds).toHaveLength(1));
      expect(adds[0]).toEqual({
        courtType: 'MAGISTRATE',
        nameAr: 'محكمة صلح يطا',
        nameEn: 'Yatta Magistrate Court',
        city: 'يطا',
      });

      fireEvent.click(screen.getByTestId(`report-dismiss-${other.id}`));
      type('dismiss-reason', ' موجودة باسم آخر ');
      fireEvent.click(screen.getByTestId('dismiss-confirm'));
      await waitFor(() => expect(dismissals).toEqual([{ reason: 'موجودة باسم آخر' }]));
    },
  );

  it('should replace an office court and promote another', { timeout: 30_000 }, async () => {
    const replaces: unknown[] = [];
    const promotes: unknown[] = [];
    server.use(
      http.get(api('admin/courts'), () => page([COURT])),
      http.get(api('admin/office-courts'), () => page([OFFICE_COURT])),
      http.post(api(`admin/office-courts/${OFFICE_COURT.id}/replace`), async ({ request }) => {
        replaces.push(await request.json());
        return ok({ courtId: COURT.id, files: 3, sessions: 2, judges: 1 });
      }),
      http.post(api(`admin/office-courts/${OFFICE_COURT.id}/promote`), async ({ request }) => {
        promotes.push(await request.json());
        return ok({ ...OFFICE_COURT, isPlatform: true });
      }),
    );
    renderCourts();
    fireEvent.click(await screen.findByTestId('tab-office-courts'));
    const table = await screen.findByTestId('office-courts-table');
    await waitFor(() => expect(table.textContent).toContain('Files: 3 · hearings: 2 · judges: 1'));

    fireEvent.click(screen.getByTestId(`office-court-replace-${OFFICE_COURT.id}`));
    fireEvent.mouseDown(within(await screen.findByRole('dialog')).getByRole('combobox'));
    fireEvent.click(await screen.findByTitle('Ramallah Magistrate Court'));
    fireEvent.click(screen.getByTestId('replace-confirm'));
    await waitFor(() => expect(replaces).toEqual([{ courtId: COURT.id }]));

    fireEvent.click(screen.getByTestId(`office-court-promote-${OFFICE_COURT.id}`));
    fireEvent.click(await screen.findByTestId('promote-confirm'));
    expect(await screen.findByText('This field is required.')).toBeTruthy();
    type('promote-name-en', 'Office Court');
    fireEvent.click(screen.getByTestId('promote-confirm'));
    await waitFor(() => expect(promotes).toEqual([{ nameEn: 'Office Court' }]));
  });

  it('should be accessible in Arabic', { timeout: 60_000 }, async () => {
    server.use(http.get(api('admin/courts'), () => page([COURT])));
    renderCourts('ar');
    await screen.findByTestId('courts-table');
    expect(document.documentElement.dir).toBe('rtl');
    const { violations } = await axe.run(document.body, {
      rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
    });
    expect(violations.map((v) => v.id)).toEqual([]);
  });
});
