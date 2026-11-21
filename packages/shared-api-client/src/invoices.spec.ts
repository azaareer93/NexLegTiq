import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

import { createApiClient } from './api-client.js';
import { invoicesApi } from './invoices.js';

const ORIGIN = 'http://api.test';
const url = (path: string) => `${ORIGIN}/api/v1/${path}`;
const meta = { timestamp: '2026-11-14T10:00:00.000Z', requestId: 'req-12345678' };
const ID = '01920000-0000-7000-8000-000000000001';
const FILE = '01920000-0000-7000-8000-0000000000f1';
const invoice = {
  id: ID,
  invoiceNumber: 'INV-2026-0001',
  status: 'SENT',
  client: { id: ID, displayName: 'C' },
  file: null,
  currency: 'ILS',
  issueDate: '2026-11-01',
  dueDate: '2026-12-01',
  subtotal: '100.00',
  taxRatePercent: '16.00',
  taxAmount: '16.00',
  total: '116.00',
  sentAt: null,
  paidAt: null,
  createdAt: meta.timestamp,
  updatedAt: meta.timestamp,
  paymentMethod: null,
  paymentReference: null,
  notes: null,
  sharedWithClient: false,
  lines: [],
};
const retainer = { fileId: FILE, currency: 'ILS', balance: '10.00', entries: [] };

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const api = () =>
  invoicesApi(
    createApiClient({
      baseURL: ORIGIN,
      realm: 'office',
      getToken: () => 't',
      setToken: () => undefined,
      onAuthFailure: vi.fn(),
    }),
  );

describe('invoicesApi', () => {
  it('should reach every invoice and retainer route with its body', async () => {
    const seen: string[] = [];
    const answer = (data: unknown, status = 200) =>
      HttpResponse.json({ success: true, data, meta }, { status });
    const record =
      (label: string, data: unknown) =>
      async ({ request }: { request: Request }) => {
        const body =
          request.method === 'GET' || request.method === 'DELETE' ? '' : await request.text();
        seen.push(`${label} ${body}`.trim());
        return label.startsWith('DELETE') ? new HttpResponse(null, { status: 204 }) : answer(data);
      };
    server.use(
      http.get(url('invoices'), () =>
        HttpResponse.json({
          success: true,
          data: [invoice],
          meta: {
            ...meta,
            pagination: { page: 1, limit: 20, total: 1, totalPages: 1, hasMore: false },
          },
        }),
      ),
      http.get(url(`invoices/${ID}`), record('GET', invoice)),
      http.post(url('invoices'), record('POST', invoice)),
      http.patch(url(`invoices/${ID}`), record('PATCH', invoice)),
      http.delete(url(`invoices/${ID}`), record('DELETE', null)),
      http.post(url(`invoices/${ID}/send`), record('SEND', invoice)),
      http.post(url(`invoices/${ID}/mark-paid`), record('PAID', invoice)),
      http.post(url(`invoices/${ID}/void`), record('VOID', invoice)),
      http.get(url(`invoices/${ID}/pdf`), () => answer({ status: 'RENDERING' }, 202)),
      http.get(url(`cases/${FILE}/retainer`), record('RETAINER', retainer)),
      http.post(url(`cases/${FILE}/retainer/deposit`), record('DEPOSIT', retainer)),
    );
    const a = api();
    await expect(a.list({ status: 'SENT' })).resolves.toMatchObject({
      items: [{ id: ID, total: '116.00' }],
    });
    await a.get(ID);
    await a.create({ clientId: ID, periodStart: '2026-11-01', periodEnd: '2026-11-30' });
    await a.update(ID, { notes: 'x' });
    await a.remove(ID);
    await a.send(ID);
    await a.markPaid(ID, { paidAt: '2026-11-10T09:00:00+02:00', method: 'RETAINER' });
    await a.void(ID);
    await expect(a.pdf(ID)).resolves.toEqual({ status: 'RENDERING' });
    await expect(a.retainer(FILE)).resolves.toEqual(retainer);
    await a.deposit(FILE, { amount: '10', paidAt: '2026-11-10T09:00:00+02:00', method: 'CASH' });
    expect(seen).toEqual([
      'GET',
      'POST {"clientId":"01920000-0000-7000-8000-000000000001","periodStart":"2026-11-01","periodEnd":"2026-11-30"}',
      'PATCH {"notes":"x"}',
      'DELETE',
      'SEND {"emailClient":false}',
      'PAID {"paidAt":"2026-11-10T09:00:00+02:00","method":"RETAINER"}',
      'VOID',
      'RETAINER',
      'DEPOSIT {"amount":"10","paidAt":"2026-11-10T09:00:00+02:00","method":"CASH"}',
    ]);
  });
});
