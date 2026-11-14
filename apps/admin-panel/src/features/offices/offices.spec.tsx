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

const ok = (data: unknown, status = 200) =>
  HttpResponse.json({ success: true, data, meta }, { status });
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

// The detail page also lists payments; a test that is not about them sees none.
const server = setupServer(http.get(api(`admin/offices/${ID}/payments`), () => ok([])));
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

  // Two full renders plus axe each: CI runners take over 60 s (the payments card added a table).
  it('should be accessible in Arabic and English', { timeout: 120_000 }, async () => {
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

  it('should show no at-risk tag for an office that is not at risk, and no last change yet', async () => {
    server.use(
      http.get(api('admin/offices'), () => page([{ ...ITEM, atRisk: false, lastWriteAt: null }])),
    );
    renderAt('/offices');
    await screen.findByTestId(`office-link-${ID}`);
    expect(screen.queryByTestId(`office-at-risk-${ID}`)).toBeNull();
    expect(screen.getByTestId('offices-table').textContent).toContain('Last change');
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

  // Two full renders plus axe each: CI runners take over 60 s (the payments card added a table).
  it('should be accessible in Arabic and English', { timeout: 120_000 }, async () => {
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

describe('office subscription action', () => {
  const PLAN_ID = '01920000-0000-7000-8000-0000000000b1';
  const PLAN = {
    id: PLAN_ID,
    code: 'PS_FREE',
    name: 'Free',
    market: 'PALESTINE',
    priceMonthly: '0.00',
    currency: 'ILS',
    maxUsers: null,
    aiQuotaMonthly: null,
    ocrPagesMonthly: 0,
    storageQuotaMb: 1,
    trialDays: null,
    features: {},
    isActive: true,
    sortOrder: 0,
    subscriptionCount: 1,
    createdAt: meta.timestamp,
    updatedAt: meta.timestamp,
  };
  const extended = {
    ...DETAIL,
    subscriptions: [{ ...DETAIL.subscriptions[0], currentPeriodEnd: '2027-12-15T12:00:00.000Z' }],
  };
  const setup = (respond: () => Response) => {
    const posts: unknown[] = [];
    server.use(
      http.get(api('admin/offices'), () => page([ITEM])),
      http.get(api(`admin/offices/${ID}`), () => ok(DETAIL)),
      http.get(api('admin/plans'), () => ok([PLAN])),
      http.post(api(`admin/offices/${ID}/subscription`), async ({ request }) => {
        posts.push(await request.json());
        return respond();
      }),
    );
    return posts;
  };
  const pickDate = async () => {
    const input = await screen.findByTestId('subscription-until');
    fireEvent.change(input, { target: { value: '15/12/2027' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', keyCode: 13 });
  };

  it('should extend the period and show the updated detail', { timeout: 30_000 }, async () => {
    const posts = setup(() => ok(extended));
    renderAt(`/offices/${ID}`);
    fireEvent.click(await screen.findByTestId('office-subscription'));
    await pickDate();
    fireEvent.click(screen.getByTestId('subscription-confirm'));
    await waitFor(() => expect(posts).toEqual([{ action: 'EXTEND_PERIOD', until: '2027-12-15' }]));
    await waitFor(() =>
      expect(screen.getByTestId('office-subscriptions').textContent).toContain('15/12/2027'),
    );
  });

  it(
    'should show the server error when a paid subscription is put on trial',
    { timeout: 30_000 },
    async () => {
      const posts = setup(() => fail(422, 'BIZ-023'));
      renderAt(`/offices/${ID}`);
      fireEvent.click(await screen.findByTestId('office-subscription'));
      fireEvent.click(await screen.findByTestId('subscription-action-SET_TRIAL'));
      await pickDate();
      fireEvent.click(screen.getByTestId('subscription-confirm'));
      expect((await screen.findByRole('alert')).textContent).toContain('paid subscription');
      expect(posts).toEqual([{ action: 'SET_TRIAL', until: '2027-12-15' }]);
    },
  );
});

describe('office payments (D-174)', () => {
  const PAYMENT = {
    id: '01920000-0000-7000-8000-0000000000c1',
    officeId: ID,
    receiptNumber: 'RCT-2026-0007',
    amount: '150.50',
    currency: 'ILS',
    method: 'BANK_TRANSFER',
    reference: 'TRX-1',
    paidAt: '2026-11-14',
    recordedBy: { id: ID, fullName: 'Founder' },
    voidedAt: null,
    voidReason: null,
    createdAt: meta.timestamp,
  };
  const setup = (rows: unknown[] = [PAYMENT]) => {
    const bodies: unknown[] = [];
    server.use(
      http.get(api(`admin/offices/${ID}`), () => ok(DETAIL)),
      http.get(api(`admin/offices/${ID}/payments`), () => ok(rows)),
      http.post(api(`admin/offices/${ID}/payments`), async ({ request }) => {
        bodies.push(await request.json());
        return ok(PAYMENT, 201);
      }),
      http.post(api(`admin/payments/${PAYMENT.id}/void`), async ({ request }) => {
        bodies.push(await request.json());
        return ok({ ...PAYMENT, voidedAt: meta.timestamp, voidReason: 'recorded twice' });
      }),
    );
    return bodies;
  };

  it(
    'should record a payment with today as the paid date and the receipt emailed',
    { timeout: 30_000 },
    async () => {
      const bodies = setup([]);
      renderAt(`/offices/${ID}`);
      fireEvent.click(await screen.findByTestId('payment-new'));
      fireEvent.change(await screen.findByTestId('payment-amount'), {
        target: { value: '150.50' },
      });
      fireEvent.change(screen.getByTestId('payment-reference'), { target: { value: 'TRX-1' } });
      fireEvent.click(screen.getByTestId('payment-confirm'));
      const today = new Date();
      const local = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
      await waitFor(() =>
        expect(bodies).toEqual([
          {
            amount: '150.50',
            currency: DETAIL.currency,
            method: 'BANK_TRANSFER',
            reference: 'TRX-1',
            paidAt: local,
            emailOffice: true,
          },
        ]),
      );
    },
  );

  it(
    'should void a payment with a reason and open a ready receipt',
    { timeout: 30_000 },
    async () => {
      const bodies = setup();
      let receipt: unknown = { status: 'RENDERING' };
      server.use(http.get(api(`admin/payments/${PAYMENT.id}/receipt`), () => ok(receipt)));
      const clicked: string[] = [];
      const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
        this: HTMLAnchorElement,
      ) {
        clicked.push(this.href);
      });
      renderAt(`/offices/${ID}`);
      expect(await screen.findByText('RCT-2026-0007')).toBeTruthy();

      fireEvent.click(screen.getByTestId(`payment-receipt-${PAYMENT.id}`));
      expect(await screen.findByText(/being prepared/)).toBeTruthy();
      receipt = { status: 'READY', downloadUrl: 'https://s3.test/r.pdf', expiresIn: 300 };
      fireEvent.click(screen.getByTestId(`payment-receipt-${PAYMENT.id}`));
      await waitFor(() => expect(clicked).toEqual(['https://s3.test/r.pdf']));
      click.mockRestore();

      fireEvent.click(screen.getByTestId(`payment-void-${PAYMENT.id}`));
      fireEvent.change(await screen.findByTestId('payment-void-reason'), {
        target: { value: 'recorded twice' },
      });
      fireEvent.click(screen.getByTestId('payment-void-confirm'));
      await waitFor(() => expect(bodies).toEqual([{ reason: 'recorded twice' }]));
    },
  );

  it('should be accessible in Arabic with payments listed', { timeout: 60_000 }, async () => {
    setup();
    renderAt(`/offices/${ID}`, 'ar');
    expect(await screen.findByText('تحويل بنكي')).toBeTruthy();
    expect(document.documentElement.dir).toBe('rtl');
    await expectAccessible();
  });
});
