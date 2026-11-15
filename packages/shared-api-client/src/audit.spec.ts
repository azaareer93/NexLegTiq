import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

import { createApiClient } from './api-client.js';
import { auditApi } from './audit.js';

const ORIGIN = 'http://api.test';
const url = (path: string) => `${ORIGIN}/api/v1/${path}`;
const meta = { timestamp: '2026-11-14T10:00:00.000Z', requestId: 'req-12345678' };
const FILE = '01920000-0000-7000-8000-0000000000f1';
const page = { items: [], nextCursor: null };

const server = setupServer();
beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const api = () =>
  auditApi(
    createApiClient({
      baseURL: ORIGIN,
      realm: 'office',
      getToken: () => 't',
      setToken: () => undefined,
      onAuthFailure: () => undefined,
    }),
  );

describe('auditApi (D-180)', () => {
  it('should read the office and file logs with their filters, and the CSV as text', async () => {
    const seen: string[] = [];
    server.use(
      http.get(url('audit'), ({ request }) => {
        seen.push(new URL(request.url).search);
        return HttpResponse.json({ success: true, data: page, meta });
      }),
      http.get(url(`cases/${FILE}/audit`), () =>
        HttpResponse.json({ success: true, data: page, meta }),
      ),
      http.get(url('audit/export'), ({ request }) => {
        seen.push(new URL(request.url).search);
        return new HttpResponse('"occurredAt"\r\n', { headers: { 'content-type': 'text/csv' } });
      }),
    );
    await expect(api().list({ action: 'LOGIN', userId: '' })).resolves.toEqual(page);
    await expect(api().file(FILE, { limit: 10 })).resolves.toEqual(page);
    await expect(api().exportCsv({ action: 'EXPORT' })).resolves.toBe('"occurredAt"\r\n');
    expect(seen).toEqual(['?action=LOGIN', '?action=EXPORT&format=csv']);
  });

  it('should turn an export refusal into an ApiError', async () => {
    server.use(
      http.get(url('audit/export'), () =>
        HttpResponse.json(
          { success: false, error: { code: 'BIZ-025', message: 'Too many', details: [] }, meta },
          { status: 422 },
        ),
      ),
    );
    await expect(api().exportCsv({})).rejects.toMatchObject({ code: 'BIZ-025' });
  });
});
