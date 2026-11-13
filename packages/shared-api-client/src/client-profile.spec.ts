import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

import { createApiClient } from './api-client.js';
import { clientProfileApi } from './client-profile.js';

const ORIGIN = 'http://api.test';
const url = (path: string) => `${ORIGIN}/api/v1/${path}`;
const meta = { timestamp: '2026-10-05T10:00:00.000Z', requestId: 'req-12345678' };
const ok = (data: unknown) => HttpResponse.json({ success: true, data, meta });
const page = (data: unknown[]) =>
  HttpResponse.json({
    success: true,
    data,
    meta: {
      ...meta,
      pagination: { page: 1, limit: 20, total: data.length, totalPages: 1, hasMore: false },
    },
  });

const CLIENT = '01920000-0000-7000-8000-0000000000c1';
const NOTE = {
  id: '01920000-0000-7000-8000-0000000000d1',
  body: 'Prefers calls',
  isConfidential: false,
  pinned: false,
  author: { id: '01920000-0000-7000-8000-0000000000a1', fullName: 'Sami' },
  canEdit: true,
  createdAt: '2026-10-03T09:00:00.000Z',
  updatedAt: '2026-10-03T09:00:00.000Z',
};
const SUMMARY = { billed: [{ currency: 'ILS', amount: '10.00', count: 1 }], outstanding: [] };

const server = setupServer();
beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const api = () =>
  clientProfileApi(
    createApiClient({
      baseURL: ORIGIN,
      realm: 'office',
      getToken: () => 'access-1',
      setToken: () => undefined,
      onAuthFailure: () => undefined,
    }),
  );

describe('clientProfileApi (MVP-55)', () => {
  it("should read and change a client's notes and read its documents, invoices and totals", async () => {
    const seen: string[] = [];
    const rec =
      (respond: () => Response) =>
      ({ request }: { request: Request }) => {
        const { pathname, search } = new URL(request.url);
        seen.push(`${request.method} ${pathname.replace('/api/v1/', '')}${search}`);
        return respond();
      };
    const n = `clients/${CLIENT}/notes`;
    server.use(
      http.get(
        url(n),
        rec(() => ok([NOTE])),
      ),
      http.post(
        url(n),
        rec(() => ok(NOTE)),
      ),
      http.patch(
        url(`${n}/${NOTE.id}`),
        rec(() => ok(NOTE)),
      ),
      http.delete(
        url(`${n}/${NOTE.id}`),
        rec(() => new HttpResponse(null, { status: 204 })),
      ),
      http.get(
        url(`clients/${CLIENT}/documents`),
        rec(() => page([])),
      ),
      http.get(
        url('invoices/summary'),
        rec(() => ok(SUMMARY)),
      ),
      http.get(
        url('invoices'),
        rec(() => page([])),
      ),
    );
    const profile = api();
    expect(await profile.notes(CLIENT)).toEqual([NOTE]);
    await profile.addNote(CLIENT, { body: 'x' });
    await profile.updateNote(CLIENT, NOTE.id, { pinned: true });
    await profile.removeNote(CLIENT, NOTE.id);
    expect((await profile.documents(CLIENT, { page: '2' })).items).toEqual([]);
    expect((await profile.invoices({ clientId: CLIENT })).items).toEqual([]);
    expect(await profile.invoiceSummary(CLIENT)).toEqual(SUMMARY);
    expect(seen).toEqual([
      `GET ${n}`,
      `POST ${n}`,
      `PATCH ${n}/${NOTE.id}`,
      `DELETE ${n}/${NOTE.id}`,
      `GET clients/${CLIENT}/documents?page=2`,
      `GET invoices?clientId=${CLIENT}`,
      `GET invoices/summary?clientId=${CLIENT}`,
    ]);
  });
});
