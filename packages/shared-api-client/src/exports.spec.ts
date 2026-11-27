import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

import { createApiClient } from './api-client.js';
import { exportsApi } from './exports.js';

const ORIGIN = 'http://api.test';
const url = (path: string) => `${ORIGIN}/api/v1/${path}`;
const meta = { timestamp: '2026-11-27T10:00:00.000Z', requestId: 'req-12345678' };
const ok = (data: unknown) => HttpResponse.json({ success: true, data, meta });

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const api = () =>
  exportsApi(
    createApiClient({
      baseURL: ORIGIN,
      getToken: () => 'access',
      setToken: () => undefined,
      onAuthFailure: vi.fn(),
    }),
  );

describe('exportsApi: office deletion (D-251)', () => {
  it('should read, request and cancel the deletion', async () => {
    const scheduled = { requestedAt: meta.timestamp, scheduledFor: '2026-12-27T10:00:00.000Z' };
    const none = { requestedAt: null, scheduledFor: null };
    let body: unknown;
    server.use(
      http.get(url('offices/me/delete-request'), () => ok(none)),
      http.post(url('offices/me/delete-request'), async ({ request }) => {
        body = await request.json();
        return ok(scheduled);
      }),
      http.post(url('offices/me/delete-request/cancel'), () => ok(none)),
    );
    await expect(api().deletion()).resolves.toEqual(none);
    await expect(api().requestDeletion({ password: 'secret' })).resolves.toEqual(scheduled);
    expect(body).toEqual({ password: 'secret' });
    await expect(api().cancelDeletion()).resolves.toEqual(none);
  });
});
