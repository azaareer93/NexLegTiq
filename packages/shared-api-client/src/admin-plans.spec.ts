import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

import { adminPlansApi } from './admin-plans.js';
import { createApiClient } from './api-client.js';

const ORIGIN = 'http://api.test';
const url = (path: string) => `${ORIGIN}/api/v1/${path}`;
const meta = { timestamp: '2026-11-14T10:00:00.000Z', requestId: 'req-12345678' };
const ID = '01920000-0000-7000-8000-000000000001';

const plan = {
  id: ID,
  code: 'PS_PRO',
  name: 'Pro',
  market: 'PALESTINE',
  priceMonthly: '25.00',
  currency: 'USD',
  maxUsers: 5,
  aiQuotaMonthly: null,
  ocrPagesMonthly: 0,
  storageQuotaMb: 1024,
  trialDays: null,
  features: { ai: true },
  isActive: true,
  sortOrder: 0,
  subscriptionCount: 1,
  createdAt: '2026-11-01T10:00:00.000Z',
  updatedAt: '2026-11-01T10:00:00.000Z',
};

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const api = () =>
  adminPlansApi(
    createApiClient({
      baseURL: ORIGIN,
      realm: 'admin',
      getToken: () => 'admin-access',
      setToken: () => undefined,
      onAuthFailure: vi.fn(),
    }),
  );

describe('adminPlansApi', () => {
  it('should list, create, update and delete plans', async () => {
    const calls: string[] = [];
    const answer = (data: unknown) => HttpResponse.json({ success: true, data, meta });
    server.use(
      http.get(url('admin/plans'), () => answer([plan])),
      http.post(url('admin/plans'), async ({ request }) => {
        calls.push(`POST ${JSON.stringify(await request.json())}`);
        return answer(plan);
      }),
      http.patch(url(`admin/plans/${ID}`), async ({ request }) => {
        calls.push(`PATCH ${JSON.stringify(await request.json())}`);
        return answer(plan);
      }),
      http.delete(url(`admin/plans/${ID}`), () => {
        calls.push('DELETE');
        return new HttpResponse(null, { status: 204 });
      }),
    );
    expect(await api().list()).toHaveLength(1);
    await api().create({ code: 'PS_PRO' } as never);
    await api().update(ID, { name: 'Pro+' });
    await api().remove(ID);
    expect(calls).toEqual(['POST {"code":"PS_PRO"}', 'PATCH {"name":"Pro+"}', 'DELETE']);
  });
});
