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
const meta = { timestamp: '2026-11-09T10:00:00.000Z', requestId: 'req-12345678' };
const ok = (data: unknown, status = 200) =>
  HttpResponse.json({ success: true, data, meta }, { status });

const PLAN = {
  id: '01920000-0000-7000-8000-0000000000b1',
  code: 'PS_FREE',
  name: 'Free plan',
  market: 'PALESTINE',
  priceMonthly: '0.00',
  currency: 'ILS',
  maxUsers: 3,
  aiQuotaMonthly: null,
  ocrPagesMonthly: 0,
  storageQuotaMb: 500,
  trialDays: null,
  features: { ai: true, clientPortal: false, googleVisionOcr: false, customPricing: true },
  isActive: true,
  sortOrder: 0,
  subscriptionCount: 0,
  createdAt: '2026-11-01T10:00:00.000Z',
  updatedAt: '2026-11-01T10:00:00.000Z',
};
const IN_USE = {
  ...PLAN,
  id: '01920000-0000-7000-8000-0000000000b2',
  code: 'PS_PRO',
  name: 'Pro plan',
  subscriptionCount: 4,
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

function renderPlans(locale: Locale = 'en') {
  localStorage.setItem(LANGUAGE_STORAGE_KEY, locale);
  useAdminSession.setState({
    status: 'authenticated',
    accessToken: 'admin-access',
    admin: { id: PLAN.id, fullName: 'Founder', email: 'founder@example.test' },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <NexProvider>
        <RouterProvider router={createMemoryRouter(routes, { initialEntries: ['/plans'] })} />
      </NexProvider>
    </QueryClientProvider>,
  );
}

const type = (testId: string, value: string) =>
  fireEvent.change(screen.getByTestId(testId), { target: { value } });

describe('plans page', () => {
  it('should list plans with unlimited limits and disable deleting a plan in use', async () => {
    server.use(http.get(api('admin/plans'), () => ok([PLAN, IN_USE])));
    renderPlans();
    const table = await screen.findByTestId('plans-table');
    expect(table.textContent).toContain('Free plan');
    expect(table.textContent).toContain('Unlimited');
    expect(table.textContent).toContain('PS_PRO');
    expect(screen.getByTestId(`plan-delete-${IN_USE.id}`).hasAttribute('disabled')).toBe(true);
    expect(screen.getByTestId(`plan-delete-${PLAN.id}`).hasAttribute('disabled')).toBe(false);
  });

  it('should create a plan with the parsed body', { timeout: 30_000 }, async () => {
    const posts: unknown[] = [];
    server.use(
      http.get(api('admin/plans'), () => ok([PLAN])),
      http.post(api('admin/plans'), async ({ request }) => {
        posts.push(await request.json());
        return ok({ ...PLAN, code: 'PS_NEW', name: 'New plan' }, 201);
      }),
    );
    renderPlans();
    fireEvent.click(await screen.findByTestId('plan-new'));
    type('plan-code', 'PS_NEW');
    type('plan-name', 'New plan');
    type('plan-price', '25.50');
    type('plan-storage', '1000');
    fireEvent.click(screen.getByTestId('plan-feature-ai'));
    fireEvent.click(screen.getByTestId('plan-confirm'));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({
      code: 'PS_NEW',
      name: 'New plan',
      market: 'PALESTINE',
      priceMonthly: '25.50',
      currency: 'ILS',
      maxUsers: null,
      aiQuotaMonthly: null,
      storageQuotaMb: 1000,
      trialDays: null,
      isActive: true,
      features: { ai: true, clientPortal: false, googleVisionOcr: false },
    });
  });

  it('should edit with only plan fields, keep other flags and a read-only code', async () => {
    const patches: unknown[] = [];
    server.use(
      http.get(api('admin/plans'), () => ok([PLAN])),
      http.patch(api(`admin/plans/${PLAN.id}`), async ({ request }) => {
        patches.push(await request.json());
        return ok(PLAN);
      }),
    );
    renderPlans();
    fireEvent.click(await screen.findByTestId(`plan-edit-${PLAN.id}`));
    expect(screen.getByTestId('plan-code').hasAttribute('disabled')).toBe(true);
    type('plan-name', 'Renamed');
    fireEvent.click(screen.getByTestId('plan-confirm'));
    await waitFor(() => expect(patches).toHaveLength(1));
    const body = patches[0] as Record<string, unknown>;
    expect(body).not.toHaveProperty('code');
    expect(body.name).toBe('Renamed');
    expect(body.features).toEqual({
      ai: true,
      clientPortal: false,
      googleVisionOcr: false,
      customPricing: true,
    });
  });

  it('should be accessible in Arabic', { timeout: 60_000 }, async () => {
    server.use(http.get(api('admin/plans'), () => ok([PLAN, IN_USE])));
    renderPlans('ar');
    await screen.findByTestId('plans-table');
    expect(document.documentElement.dir).toBe('rtl');
    const { violations } = await axe.run(document.body, {
      rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
    });
    expect(violations.map((v) => v.id)).toEqual([]);
  });
});
