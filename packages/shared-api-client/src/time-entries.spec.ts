import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

import { createApiClient } from './api-client.js';
import { timeEntriesApi } from './time-entries.js';

const ORIGIN = 'http://api.test';
const url = (path: string) => `${ORIGIN}/api/v1/${path}`;
const meta = { timestamp: '2026-10-05T10:00:00.000Z', requestId: 'req-12345678' };
const ok = (data: unknown, extra: object = {}) =>
  HttpResponse.json({ success: true, data, meta: { ...meta, ...extra } });
const noContent = () => new HttpResponse(null, { status: 204 });

const FILE = {
  id: '01920000-0000-7000-8000-0000000001f1',
  fileNumber: '2026-LIT-00007',
  title: 'T',
};
const ENTRY = {
  id: '01920000-0000-7000-8000-0000000009a1',
  file: FILE,
  user: { id: '01920000-0000-7000-8000-0000000000a1', fullName: 'Omar Haddad' },
  workDate: '2026-11-09',
  durationHours: '1.50',
  description: 'Drafting',
  isBillable: true,
  hourlyRate: '150.00',
  amount: '225.00',
  currency: 'ILS',
  invoiced: false,
  createdAt: '2026-11-09T09:00:00.000Z',
  updatedAt: '2026-11-09T09:00:00.000Z',
};
const TIMER = {
  id: '01920000-0000-7000-8000-0000000009b1',
  file: FILE,
  description: null,
  startedAt: '2026-11-09T09:00:00.000Z',
};
const TOTALS = {
  currency: 'ILS',
  billableHours: '1.50',
  nonBillableHours: '0.00',
  unbilledHours: '1.50',
  billableAmount: '225.00',
  unbilledAmount: '225.00',
};
const PAGE = { pagination: { page: 1, limit: 20, total: 1, totalPages: 1, hasMore: false } };

const server = setupServer();
beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const api = () =>
  timeEntriesApi(
    createApiClient({
      baseURL: ORIGIN,
      realm: 'office',
      getToken: () => 'access-1',
      setToken: () => undefined,
      onAuthFailure: () => undefined,
    }),
  );

describe('timeEntriesApi (D-152)', () => {
  it('should list, write, run the timer and read totals', async () => {
    const seen: string[] = [];
    const record = async (request: Request) => {
      const { pathname, search } = new URL(request.url);
      const body = await request.text();
      seen.push(`${request.method} ${pathname.replace('/api/v1/', '')}${search} ${body}`.trim());
    };
    server.use(
      http.get(
        url('time-entries'),
        async ({ request }) => (await record(request), ok([ENTRY], PAGE)),
      ),
      http.post(url('time-entries'), async ({ request }) => (await record(request), ok(ENTRY))),
      http.get(url('time-entries/timer'), async ({ request }) => (await record(request), ok(null))),
      http.post(
        url('time-entries/timer/start'),
        async ({ request }) => (await record(request), ok(TIMER)),
      ),
      http.post(
        url('time-entries/timer/stop'),
        async ({ request }) => (await record(request), ok(ENTRY)),
      ),
      http.delete(
        url('time-entries/timer'),
        async ({ request }) => (await record(request), noContent()),
      ),
      http.patch(
        url(`time-entries/${ENTRY.id}`),
        async ({ request }) => (await record(request), ok(ENTRY)),
      ),
      http.delete(
        url(`time-entries/${ENTRY.id}`),
        async ({ request }) => (await record(request), noContent()),
      ),
      http.get(
        url(`cases/${FILE.id}/time-totals`),
        async ({ request }) => (await record(request), ok(TOTALS)),
      ),
    );
    const client = api();
    expect((await client.list({ fileId: FILE.id })).items).toHaveLength(1);
    await client.create({
      fileId: FILE.id,
      durationHours: '1.5',
      description: 'x',
      isBillable: true,
    });
    expect(await client.timer()).toBeNull();
    expect((await client.startTimer({ fileId: FILE.id })).id).toBe(TIMER.id);
    await client.stopTimer({ description: 'x', isBillable: false });
    await client.discardTimer();
    await client.update(ENTRY.id, { isBillable: false });
    await client.remove(ENTRY.id);
    expect((await client.totals(FILE.id)).billableAmount).toBe('225.00');
    expect(seen).toEqual([
      `GET time-entries?fileId=${FILE.id}`,
      `POST time-entries {"fileId":"${FILE.id}","durationHours":"1.5","description":"x","isBillable":true}`,
      'GET time-entries/timer',
      `POST time-entries/timer/start {"fileId":"${FILE.id}"}`,
      'POST time-entries/timer/stop {"description":"x","isBillable":false}',
      'DELETE time-entries/timer',
      `PATCH time-entries/${ENTRY.id} {"isBillable":false}`,
      `DELETE time-entries/${ENTRY.id}`,
      `GET cases/${FILE.id}/time-totals`,
    ]);
  });
});
