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
const meta = { timestamp: '2026-11-15T10:00:00.000Z', requestId: 'req-12345678' };
const ok = (data: unknown) => HttpResponse.json({ success: true, data, meta });
const OFFICE = '01920000-0000-7000-8000-0000000000b1';
const ADMIN = '01920000-0000-7000-8000-0000000000c1';

const USAGE = {
  since: '2026-10-16',
  aiCostByDay: [
    { date: '2026-11-14', costUsd: '0.5', operations: 4 },
    { date: '2026-11-15', costUsd: '1.25', operations: 9 },
  ],
  aiCostByOffice: [
    { officeId: OFFICE, officeName: 'Haddad Law', model: 'gpt-x', costUsd: '1.75', operations: 13 },
  ],
  storageByOffice: [{ officeId: OFFICE, officeName: 'Haddad Law', bytes: String(5 * 1024 * 1024) }],
  activeUsers: { daily: 3, weekly: 11 },
  signups: { offices: 4, verified: 3, withCase: 2 },
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

function open(path: string, locale: Locale = 'en') {
  localStorage.setItem(LANGUAGE_STORAGE_KEY, locale);
  useAdminSession.setState({
    status: 'authenticated',
    accessToken: 'admin-access',
    admin: { id: ADMIN, fullName: 'Founder', email: 'founder@example.test' },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <NexProvider>
        <RouterProvider router={createMemoryRouter(routes, { initialEntries: [path] })} />
      </NexProvider>
    </QueryClientProvider>,
  );
}

describe('platform usage pages (MVP-103)', () => {
  it('should show active users, the funnel, cost per day and per office, storage, and change the range', async () => {
    const asked: string[] = [];
    server.use(
      http.get(api('admin/usage'), ({ request }) => {
        asked.push(new URL(request.url).search);
        return ok(USAGE);
      }),
    );
    open('/usage');
    const funnel = await screen.findByTestId('usage-funnel');
    expect(funnel.textContent).toContain('4');
    expect(screen.getByTestId('usage-bar-2026-11-15')).toBeTruthy();
    expect(screen.getByTestId('usage-cost-offices').textContent).toContain('Haddad Law');
    expect(screen.getByTestId('usage-storage').textContent).toContain('5 MB');
    fireEvent.click(screen.getByText('7 days'));
    await waitFor(() => expect(asked.at(-1)).toBe('?days=7'));
  });

  it('should mark a queue with failed jobs in words', async () => {
    server.use(
      http.get(api('admin/queues'), () =>
        ok([
          { name: 'email', waiting: 0, active: 0, delayed: 0, failed: 2 },
          { name: 'ai', waiting: 1, active: 0, delayed: 0, failed: 0 },
        ]),
      ),
    );
    open('/queues');
    expect((await screen.findByTestId('queue-failed-email')).textContent).toBe('2 failed');
  });

  it('should list the platform audit, filter by action and export it', async () => {
    const asked: string[] = [];
    let exported = '';
    server.use(
      http.get(api('admin/audit'), ({ request }) => {
        asked.push(new URL(request.url).search);
        return ok({
          items: [
            {
              id: '01920000-0000-7000-8000-0000000000d1',
              occurredAt: '2026-11-15T08:00:00.000Z',
              admin: { id: ADMIN, name: 'Founder' },
              action: 'OFFICE_SUSPENDED',
              entityType: 'Office',
              entityId: OFFICE,
              office: { id: OFFICE, name: 'Haddad Law' },
              changes: [{ field: 'isActive', old: true, new: false }],
            },
          ],
          nextCursor: null,
        });
      }),
      http.get(api('admin/audit/export'), ({ request }) => {
        exported = new URL(request.url).search;
        return new HttpResponse('"occurredAt"\r\n', { headers: { 'content-type': 'text/csv' } });
      }),
    );
    const clicks: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicks.push(this.download);
    });
    URL.createObjectURL = vi.fn(() => 'blob:audit');
    URL.revokeObjectURL = vi.fn();
    open('/audit');
    const table = await screen.findByTestId('platform-audit-table');
    await waitFor(() => expect(table.textContent).toContain('OFFICE_SUSPENDED'));
    expect(table.textContent).toContain('Haddad Law');
    const wrapper = screen.getByTestId('platform-audit-action');
    const search = (wrapper.querySelector('input') ?? wrapper) as HTMLInputElement;
    fireEvent.change(search, { target: { value: 'office_suspended' } });
    fireEvent.keyDown(search, { key: 'Enter', code: 'Enter' });
    await waitFor(() => expect(asked.at(-1)).toContain('action=OFFICE_SUSPENDED'));
    fireEvent.click(screen.getByTestId('platform-audit-export'));
    await waitFor(() => expect(clicks).toEqual(['platform-audit.csv']));
    expect(exported).toContain('action=OFFICE_SUSPENDED');
    click.mockRestore();
  });

  it('should be accessible in Arabic', async () => {
    server.use(http.get(api('admin/usage'), () => ok(USAGE)));
    open('/usage', 'ar');
    await screen.findByTestId('usage-funnel');
    expect(document.documentElement.dir).toBe('rtl');
    const { violations } = await axe.run(document.body, {
      rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
    });
    expect(violations.map((v) => v.id)).toEqual([]);
  });
});
