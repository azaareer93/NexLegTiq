import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

import { adminOfficesApi } from './admin-offices.js';
import { createApiClient } from './api-client.js';

const ORIGIN = 'http://api.test';
const url = (path: string) => `${ORIGIN}/api/v1/${path}`;
const meta = { timestamp: '2026-11-09T10:00:00.000Z', requestId: 'req-12345678' };
const ID = '01920000-0000-7000-8000-000000000001';

const item = {
  id: ID,
  name: 'Office A',
  jurisdiction: 'PALESTINE',
  status: 'ACTIVE',
  createdAt: '2026-11-01T10:00:00.000Z',
  plan: { code: 'PS_FREE', name: 'Free' },
  subscriptionStatus: 'ACTIVE',
  usage: { activeUsers: 2, liveFiles: 3, storageMb: 4, aiThisMonth: 5 },
  lastActivityAt: null,
  lastWriteAt: null,
  atRisk: false,
};
const detail = {
  ...item,
  accountType: 'FIRM',
  email: null,
  phone: null,
  currency: 'ILS',
  timezone: 'Asia/Hebron',
  subscriptions: [],
  suspension: null,
  statistics: {
    signedIn30d: 1,
    filesByStatus: { OPEN: 1, SUSPENDED: 0, CLOSED: 0, ARCHIVED: 0 },
    filesNew30d: 0,
    documents: 0,
    documentsNew30d: 0,
    writes30d: 0,
    aiEnabled: true,
    ocrEnabled: false,
  },
};

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const api = () =>
  adminOfficesApi(
    createApiClient({
      baseURL: ORIGIN,
      realm: 'admin',
      getToken: () => 'admin-access',
      setToken: () => undefined,
      onAuthFailure: vi.fn(),
    }),
  );

describe('adminOfficesApi', () => {
  it('should list offices with the query and the pagination', async () => {
    let search = '';
    server.use(
      http.get(url('admin/offices'), ({ request }) => {
        search = new URL(request.url).search;
        return HttpResponse.json({
          success: true,
          data: [item],
          meta: {
            ...meta,
            pagination: { page: 1, limit: 20, total: 1, totalPages: 1, hasMore: false },
          },
        });
      }),
    );
    const page = await api().list({ status: 'SUSPENDED', search: 'a' });
    expect(page.items).toHaveLength(1);
    expect(page.pagination.total).toBe(1);
    expect(search).toBe('?status=SUSPENDED&search=a');
  });

  it('should get, suspend and reactivate an office', async () => {
    const bodies: unknown[] = [];
    const answer = () => HttpResponse.json({ success: true, data: detail, meta });
    server.use(
      http.get(url(`admin/offices/${ID}`), answer),
      http.post(url(`admin/offices/${ID}/suspend`), async ({ request }) => {
        bodies.push(await request.json());
        return answer();
      }),
      http.post(url(`admin/offices/${ID}/reactivate`), async ({ request }) => {
        bodies.push(await request.json());
        return answer();
      }),
    );
    await expect(api().get(ID)).resolves.toMatchObject({ id: ID });
    await api().suspend(ID, { reason: 'Unpaid' });
    await api().reactivate(ID, {});
    expect(bodies).toEqual([{ reason: 'Unpaid' }, {}]);
  });

  it('should send a subscription action', async () => {
    let body: unknown;
    server.use(
      http.post(url(`admin/offices/${ID}/subscription`), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ success: true, data: detail, meta });
      }),
    );
    await api().changeSubscription(ID, { action: 'SET_TRIAL', until: '2027-01-31' });
    expect(body).toEqual({ action: 'SET_TRIAL', until: '2027-01-31' });
  });

  it('should reject a 404 as an ApiError', async () => {
    server.use(
      http.get(url(`admin/offices/${ID}`), () =>
        HttpResponse.json(
          { success: false, error: { code: 'RES-001', message: 'x' }, meta },
          { status: 404 },
        ),
      ),
    );
    await expect(api().get(ID)).rejects.toMatchObject({ code: 'RES-001', status: 404 });
  });
});
