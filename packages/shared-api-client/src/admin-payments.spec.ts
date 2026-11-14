import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

import { adminPaymentsApi } from './admin-payments.js';
import { createApiClient } from './api-client.js';

const ORIGIN = 'http://api.test';
const url = (path: string) => `${ORIGIN}/api/v1/${path}`;
const meta = { timestamp: '2026-11-14T10:00:00.000Z', requestId: 'req-12345678' };
const OFFICE = '01920000-0000-7000-8000-000000000001';
const ID = '01920000-0000-7000-8000-000000000002';

const payment = {
  id: ID,
  officeId: OFFICE,
  receiptNumber: 'RCT-2026-0001',
  amount: '150.50',
  currency: 'ILS',
  method: 'CASH',
  reference: null,
  paidAt: '2026-11-14',
  recordedBy: { id: OFFICE, fullName: 'Admin' },
  voidedAt: null,
  voidReason: null,
  createdAt: '2026-11-14T10:00:00.000Z',
};

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const api = () =>
  adminPaymentsApi(
    createApiClient({
      baseURL: ORIGIN,
      realm: 'admin',
      getToken: () => 'admin-access',
      setToken: () => undefined,
      onAuthFailure: vi.fn(),
    }),
  );

describe('adminPaymentsApi', () => {
  it('should list, record and void payments, and read a receipt that is still rendering', async () => {
    const bodies: unknown[] = [];
    const answer = (data: unknown, status = 200) =>
      HttpResponse.json({ success: true, data, meta }, { status });
    server.use(
      http.get(url(`admin/offices/${OFFICE}/payments`), () => answer([payment])),
      http.post(url(`admin/offices/${OFFICE}/payments`), async ({ request }) => {
        bodies.push(await request.json());
        return answer(payment, 201);
      }),
      http.post(url(`admin/payments/${ID}/void`), async ({ request }) => {
        bodies.push(await request.json());
        return answer({ ...payment, voidedAt: '2026-11-14T11:00:00.000Z', voidReason: 'twice' });
      }),
      http.get(url(`admin/payments/${ID}/receipt`), () => answer({ status: 'RENDERING' }, 202)),
    );
    await expect(api().list(OFFICE)).resolves.toEqual([payment]);
    const body = {
      amount: '150.50',
      currency: 'ILS',
      method: 'CASH' as const,
      paidAt: '2026-11-14',
      emailOffice: true,
    };
    await expect(api().record(OFFICE, body)).resolves.toEqual(payment);
    await expect(api().void(ID, 'twice')).resolves.toMatchObject({ voidReason: 'twice' });
    await expect(api().receipt(ID)).resolves.toEqual({ status: 'RENDERING' });
    expect(bodies).toEqual([body, { reason: 'twice' }]);
  });
});
