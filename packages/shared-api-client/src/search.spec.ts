import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

import { createApiClient } from './api-client.js';
import { searchApi } from './search.js';

const ORIGIN = 'http://api.test';
const meta = { timestamp: '2026-11-14T10:00:00.000Z', requestId: 'req-12345678' };
const EMPTY = { items: [], hasMore: false };
const RESULTS = { cases: EMPTY, clients: EMPTY, parties: EMPTY, documents: EMPTY, tasks: EMPTY };

const server = setupServer();
beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('searchApi (D-167)', () => {
  it('should send the query and check the grouped answer', async () => {
    let query = '';
    server.use(
      http.get(`${ORIGIN}/api/v1/search`, ({ request }) => {
        query = new URL(request.url).search;
        return HttpResponse.json({ success: true, data: RESULTS, meta });
      }),
    );
    const api = searchApi(
      createApiClient({
        baseURL: ORIGIN,
        realm: 'office',
        getToken: () => 'access-1',
        setToken: () => undefined,
        onAuthFailure: () => undefined,
      }),
    );
    await expect(api.search({ q: 'عقد', type: 'cases', limit: 20 })).resolves.toEqual(RESULTS);
    expect(new URLSearchParams(query).get('q')).toBe('عقد');
    expect(new URLSearchParams(query).get('type')).toBe('cases');
  });
});
