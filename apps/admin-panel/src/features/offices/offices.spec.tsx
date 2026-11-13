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
const meta = { timestamp: '2026-11-09T10:00:00.000Z', requestId: 'req-12345678' };
const ID = '01920000-0000-7000-8000-000000000001';

const ITEM = {
  id: ID,
  name: 'Haddad & Partners',
  jurisdiction: 'PALESTINE',
  status: 'ACTIVE',
  createdAt: '2026-11-01T10:00:00.000Z',
  plan: { code: 'PS_FREE', name: 'Free plan' },
  subscriptionStatus: 'ACTIVE',
  usage: { activeUsers: 3, liveFiles: 12, storageMb: 40, aiThisMonth: 2 },
  lastActivityAt: '2026-11-08T10:00:00.000Z',
  lastWriteAt: '2026-11-07T10:00:00.000Z',
  atRisk: true,
};
const DETAIL = {
  ...ITEM,
  accountType: 'FIRM',
  email: 'office@example.test',
  phone: '+970599123456',
  currency: 'ILS',
  timezone: 'Asia/Hebron',
  subscriptions: [
    {
      id: '01920000-0000-7000-8000-0000000000a1',
      plan: { code: 'PS_FREE', name: 'Free plan' },
      status: 'ACTIVE',
      currentPeriodStart: '2026-11-01T10:00:00.000Z',
      currentPeriodEnd: '2027-05-01T10:00:00.000Z',
      trialEndsAt: null,
      createdAt: '2026-11-01T10:00:00.000Z',
    },
  ],
  suspension: null,
  statistics: {
    signedIn30d: 1,
    filesByStatus: { OPEN: 1, SUSPENDED: 0, CLOSED: 0, ARCHIVED: 0 },
    filesNew30d: 0,
    documents: 0,
    documentsNew30d: 0,
    writes30d: 17,
    aiEnabled: true,
    ocrEnabled: false,
  },
};
const SUSPENDED = {
  ...DETAIL,
  status: 'SUSPENDED',
  suspension: { at: '2026-11-08T10:00:00.000Z', reason: 'Unpaid invoices' },
};

const ok = (data: unknown) => HttpResponse.json({ success: true, data, meta });
const page = (items: unknown[]) =>
  HttpResponse.json({
    success: true,
    data: items,
    meta: {
      ...meta,
      pagination: {
        page: 1,
        limit: 20,
        total: items.length,
        totalPages: items.length ? 1 : 0,
        hasMore: false,
      },
    },
  });
const fail = (status: number, code: string) =>
  HttpResponse.json({ success: false, error: { code, message: code }, meta }, { status });

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  resetSession();
  localStorage.clear();
});
afterAll(() => server.close());

function renderAt(path: string, locale: Locale = 'en') {
  localStorage.setItem(LANGUAGE_STORAGE_KEY, locale);
  useAdminSession.setState({
    status: 'authenticated',
    accessToken: 'admin-access',
    admin: { id: ID, fullName: 'Founder', email: 'founder@example.test' },
  });
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

async function expectAccessible(): Promise<void> {
  const { violations } = await axe.run(document.body, {
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
  });
  expect(violations.map((violation) => violation.id)).toEqual([]);
}

describe('offices list', () => {
  it(
    'should render rows and put a filter into the URL and the request',
    { timeout: 30_000 },
    async () => {
      const seen: string[] = [];
      server.use(
        http.get(api('admin/offices'), ({ request }) => {
          seen.push(new URL(request.url).search);
          return page([ITEM]);
        }),
      );
      const router = renderAt('/offices?bogus=1&jurisdiction=MARS');
      const row = await screen.findByTestId(`office-link-${ID}`);
      expect(row.textContent).toContain('Haddad & Partners');
      expect(screen.getByTestId('offices-table').textContent).toContain('Free plan');
      expect(screen.getByTestId(`office-at-risk-${ID}`)).toBeTruthy();
      expect(seen[0]).toBe(''); // invalid parameters are dropped

      const search = within(screen.getByTestId('offices-search')).getByRole('searchbox');
      fireEvent.change(search, { target: { value: 'Haddad' } });
      fireEvent.keyDown(search, { key: 'Enter', code: 'Enter', keyCode: 13 });
      await waitFor(() => expect(router.state.location.search).toContain('search=Haddad'));
      await waitFor(() => expect(seen).toContain('?search=Haddad'));
    },
  );

  it('should show the empty state', async () => {
    server.use(http.get(api('admin/offices'), () => page([])));
    renderAt('/offices');
    expect(await screen.findByTestId('offices-empty')).toBeTruthy();
  });

  it('should show the error state with a reference', async () => {
    server.use(http.get(api('admin/offices'), () => fail(500, 'SYS-001')));
    renderAt('/offices');
    const error = await screen.findByTestId('offices-error', {}, { timeout: 5000 });
    expect(error.textContent).toContain('req-12345678');
  });

  it('should be accessible in Arabic and English', { timeout: 60_000 }, async () => {
    server.use(http.get(api('admin/offices'), () => page([ITEM])));
    renderAt('/offices', 'ar');
    await screen.findByTestId(`office-link-${ID}`);
    expect(document.documentElement.dir).toBe('rtl');
    await expectAccessible();
    cleanup();
    renderAt('/offices', 'en');
    await screen.findByTestId(`office-link-${ID}`);
    await expectAccessible();
  });
});

describe('offices list review cases', () => {
  it('should move a page past the end to the last page', async () => {
    const seen: string[] = [];
    server.use(
      http.get(api('admin/offices'), ({ request }) => {
        const search = new URL(request.url).search;
        seen.push(search);
        if (search.includes('page=2')) {
          return HttpResponse.json({
            success: true,
            data: [ITEM],
            meta: {
              ...meta,
              pagination: { page: 2, limit: 20, total: 21, totalPages: 2, hasMore: false },
            },
          });
        }
        return HttpResponse.json({
          success: true,
          data: [],
          meta: {
            ...meta,
            pagination: { page: 5, limit: 20, total: 21, totalPages: 2, hasMore: false },
          },
        });
      }),
    );
    const router = renderAt('/offices?page=5');
    await screen.findByTestId(`office-link-${ID}`);
    expect(router.state.location.search).toBe('?page=2');
  });

  it('should write the status filter into the URL', async () => {
    server.use(http.get(api('admin/offices'), () => page([ITEM])));
    const router = renderAt('/offices');
    await screen.findByTestId(`office-link-${ID}`);
    const plan = within(screen.getByTestId('offices-plan').parentElement as HTMLElement).getByRole(
      'textbox',
    );
    fireEvent.change(plan, { target: { value: 'PS_FREE' } });
    fireEvent.keyDown(plan, { key: 'Enter', code: 'Enter', keyCode: 13 });
    await waitFor(() => expect(router.state.location.search).toBe('?plan=PS_FREE'));
  });
});

describe('office detail', () => {
  const detailServer = (initial: unknown) => {
    const posts: { path: string; body: unknown }[] = [];
    server.use(
      http.get(api('admin/offices'), () => page([ITEM])),
      http.get(api(`admin/offices/${ID}`), () => ok(initial)),
      http.post(api(`admin/offices/${ID}/suspend`), async ({ request }) => {
        posts.push({ path: 'suspend', body: await request.json() });
        return ok(SUSPENDED);
      }),
      http.post(api(`admin/offices/${ID}/reactivate`), async ({ request }) => {
        posts.push({ path: 'reactivate', body: await request.json() });
        return ok(DETAIL);
      }),
    );
    return posts;
  };

  it('should render the office', async () => {
    detailServer(DETAIL);
    renderAt(`/offices/${ID}`);
    expect((await screen.findByTestId('page-office')).textContent).toContain('office@example.test');
    expect(screen.getByTestId('office-usage').textContent).toContain('40');
    const stats = screen.getByTestId('office-statistics').textContent;
    expect(stats).toContain('17');
    expect(stats).toContain('Open: 1');
    expect(stats).toContain('Off');
    expect(screen.getByTestId(`office-at-risk-${ID}`).textContent).toBe('Needs follow-up');
    expect(screen.getByTestId('office-subscriptions').textContent).toContain('Free plan');
    expect(screen.queryByTestId('office-suspension')).toBeNull();
  });

  it(
    'should require a reason to suspend, post it and show the banner',
    { timeout: 30_000 },
    async () => {
      const posts = detailServer(DETAIL);
      renderAt(`/offices/${ID}`);
      fireEvent.click(await screen.findByTestId('office-action'));
      fireEvent.click(await screen.findByTestId('office-action-confirm'));
      await waitFor(() =>
        expect(document.querySelector('.ant-form-item-explain-error')).toBeTruthy(),
      );
      expect(posts).toEqual([]);

      fireEvent.change(screen.getByTestId('office-action-reason'), {
        target: { value: 'Unpaid invoices' },
      });
      fireEvent.click(screen.getByTestId('office-action-confirm'));
      expect((await screen.findByTestId('office-suspension')).textContent).toContain(
        'Unpaid invoices',
      );
      expect(posts).toEqual([{ path: 'suspend', body: { reason: 'Unpaid invoices' } }]);
      expect(screen.getByTestId('office-action').textContent).toBe('Reactivate');
    },
  );

  it('should keep the modal open and show the error when suspending fails', async () => {
    detailServer(DETAIL);
    server.use(http.post(api(`admin/offices/${ID}/suspend`), () => fail(500, 'SYS-001')));
    renderAt(`/offices/${ID}`);
    fireEvent.click(await screen.findByTestId('office-action'));
    fireEvent.change(await screen.findByTestId('office-action-reason'), {
      target: { value: 'Unpaid invoices' },
    });
    fireEvent.click(screen.getByTestId('office-action-confirm'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('req-12345678'));
    expect(screen.getByTestId('office-action-reason')).toBeTruthy();
    expect(screen.queryByTestId('office-suspension')).toBeNull();
  });

  it('should reactivate a suspended office without a reason', async () => {
    const posts = detailServer(SUSPENDED);
    renderAt(`/offices/${ID}`);
    await screen.findByTestId('office-suspension');
    fireEvent.click(screen.getByTestId('office-action'));
    fireEvent.click(await screen.findByTestId('office-action-confirm'));
    await waitFor(() => expect(screen.queryByTestId('office-suspension')).toBeNull());
    expect(posts).toEqual([{ path: 'reactivate', body: {} }]);
  });

  it('should show a not-found state for an unknown office', async () => {
    server.use(http.get(api(`admin/offices/${ID}`), () => fail(404, 'RES-001')));
    renderAt(`/offices/${ID}`);
    expect(await screen.findByTestId('office-not-found')).toBeTruthy();
  });

  it('should be accessible in Arabic and English', { timeout: 60_000 }, async () => {
    detailServer(SUSPENDED);
    renderAt(`/offices/${ID}`, 'ar');
    await screen.findByTestId('office-suspension');
    await expectAccessible();
    cleanup();
    renderAt(`/offices/${ID}`, 'en');
    await screen.findByTestId('office-suspension');
    await expectAccessible();
  });
});
