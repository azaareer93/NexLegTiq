import { readFileSync } from 'node:fs';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { z } from 'zod';

import { createApiClient, IDEMPOTENCY_HEADER, idempotencyHeaders } from './api-client.js';
import type { ApiClientConfig, Realm } from './api-client.js';
import { ApiError } from './api-error.js';

const ORIGIN = 'http://api.test';
const url = (path: string) => `${ORIGIN}/api/v1/${path}`;
const meta = { timestamp: '2026-10-05T10:00:00.000Z', requestId: 'req-12345678' };
const ok = (data: unknown, status = 200) => HttpResponse.json({ success: true, data, meta }, { status });
const fail = (status: number, code: string, details?: unknown) =>
  HttpResponse.json({ success: false, error: { code, message: `dev message ${code}`, details }, meta }, { status });

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

/** A client whose in-memory token store the test can inspect. */
function setup(realm: Realm = 'office', token: string | null = 'old-token') {
  const store = { token };
  const onAuthFailure = vi.fn<ApiClientConfig['onAuthFailure']>();
  const setToken = vi.fn((next: string | null) => {
    store.token = next;
  });
  const client = createApiClient({ baseURL: ORIGIN, realm, getToken: () => store.token, setToken, onAuthFailure });
  return { client, store, onAuthFailure, setToken };
}

/** Protected resource: 401 AUTH-002 unless the request carries the fresh token. */
function protectedResource(seen: string[] = []) {
  return http.get(url('things'), ({ request }) => {
    const auth = request.headers.get('authorization') ?? '';
    seen.push(auth);
    return auth === 'Bearer new-token' ? ok({ id: 1 }) : fail(401, 'AUTH-002');
  });
}

const Thing = z.object({ id: z.number() });

async function rejection(promise: Promise<unknown>): Promise<ApiError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(ApiError);
  return error as ApiError;
}

describe('createApiClient', () => {
  it('should send the bearer token and the CSRF header, and unwrap the envelope', async () => {
    let headers: Headers | undefined;
    server.use(
      http.get(url('things/1'), ({ request }) => {
        headers = request.headers;
        return ok({ id: 1, extra: 'dropped' });
      }),
    );
    const { client } = setup('office', 'new-token');
    await expect(client.request({ method: 'GET', path: '/things/1' }, Thing)).resolves.toEqual({ id: 1 });
    expect(headers?.get('authorization')).toBe('Bearer new-token');
    expect(headers?.get('x-requested-with')).toBe('XMLHttpRequest');
  });

  it('should send no Authorization header without a token, and pass query and body', async () => {
    let seen: { auth: string | null; q: string | null; body: unknown } | undefined;
    server.use(
      http.post(url('things'), async ({ request }) => {
        seen = { auth: request.headers.get('authorization'), q: new URL(request.url).searchParams.get('q'), body: await request.json() };
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const { client } = setup('office', null);
    await expect(client.request({ method: 'POST', path: 'things', query: { q: 'x', skip: undefined }, body: { a: 1 } })).resolves.toBeUndefined();
    expect(seen).toEqual({ auth: null, q: 'x', body: { a: 1 } });
  });

  it('should turn an error envelope into an ApiError with code, status, details and request id', async () => {
    server.use(http.post(url('things'), () => fail(400, 'VAL-001', [{ field: 'title', message: 'validation.required' }])));
    const error = await rejection(setup().client.request({ method: 'POST', path: 'things', body: {} }));
    expect(error).toMatchObject({
      code: 'VAL-001',
      status: 400,
      message: 'dev message VAL-001',
      details: [{ field: 'title', message: 'validation.required' }],
      requestId: 'req-12345678',
    });
  });

  it('should map an error code this build does not know to SYS-001', async () => {
    server.use(http.get(url('things'), () => fail(422, 'NEW-999')));
    expect(await rejection(setup().client.request({ method: 'GET', path: 'things' }))).toMatchObject({ code: 'SYS-001', status: 422 });
  });

  it.each([
    [502, 'SYS-002'],
    [500, 'SYS-001'],
  ])('should map a %i that is not an envelope (proxy page) to %s, keeping the request id header', async (status, code) => {
    server.use(http.get(url('things'), () => new HttpResponse('<html>Bad gateway</html>', { status, headers: { 'x-request-id': 'req-proxy-1' } })));
    expect(await rejection(setup().client.request({ method: 'GET', path: 'things' }))).toMatchObject({ code, status, requestId: 'req-proxy-1' });
  });

  it('should map a network failure to SYS-002 with status 0', async () => {
    server.use(http.get(url('things'), () => HttpResponse.error()));
    expect(await rejection(setup().client.request({ method: 'GET', path: 'things' }))).toMatchObject({ code: 'SYS-002', status: 0 });
  });

  it('should reject a 2xx body that is not an envelope, or does not match the contract', async () => {
    server.use(
      http.get(url('plain'), () => HttpResponse.json({ id: 1 })),
      http.get(url('things'), () => ok({ id: 'one' })),
    );
    const { client } = setup('office', 'new-token');
    expect(await rejection(client.request({ method: 'GET', path: 'plain' }, Thing))).toMatchObject({ code: 'SYS-001', status: 200 });
    expect(await rejection(client.request({ method: 'GET', path: 'things' }, Thing))).toMatchObject({ code: 'SYS-001', requestId: 'req-12345678' });
  });

  it('should pass a cancellation through untouched', async () => {
    server.use(http.get(url('things'), () => ok({ id: 1 })));
    const controller = new AbortController();
    controller.abort();
    const error: unknown = await setup().client.request({ method: 'GET', path: 'things', signal: controller.signal }, Thing).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(ApiError);
    expect((error as { code?: string }).code).toBe('ERR_CANCELED');
  });
});

describe('token refresh', () => {
  it('should refresh exactly once for concurrent 401 AUTH-002s and retry each request once with the new token', async () => {
    let refreshes = 0;
    const seen: string[] = [];
    let refreshHeaders: Headers | undefined;
    server.use(
      protectedResource(seen),
      http.post(url('auth/refresh'), async ({ request }) => {
        refreshes += 1;
        refreshHeaders = request.headers;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return ok({ accessToken: 'new-token', expiresIn: 900 });
      }),
    );
    const { client, store, onAuthFailure } = setup();
    const results = await Promise.all(Array.from({ length: 5 }, () => client.request({ method: 'GET', path: 'things' }, Thing)));

    expect(results).toEqual(Array.from({ length: 5 }, () => ({ id: 1 })));
    expect(refreshes).toBe(1);
    expect(seen.filter((auth) => auth === 'Bearer old-token')).toHaveLength(5);
    expect(seen.filter((auth) => auth === 'Bearer new-token')).toHaveLength(5);
    expect(store.token).toBe('new-token');
    expect(onAuthFailure).not.toHaveBeenCalled();
    // The refresh itself carries no bearer token, only the cookie and the CSRF header.
    expect(refreshHeaders?.get('authorization')).toBeNull();
    expect(refreshHeaders?.get('x-requested-with')).toBe('XMLHttpRequest');
  });

  it('should retry without refreshing again when another refresh already replaced the token', async () => {
    let refreshes = 0;
    server.use(
      http.get(url('things'), ({ request }) => {
        // The token is swapped while this request is on its way, as when a parallel refresh finishes first.
        store.token = 'new-token';
        return request.headers.get('authorization') === 'Bearer new-token' ? ok({ id: 1 }) : fail(401, 'AUTH-002');
      }),
      http.post(url('auth/refresh'), () => {
        refreshes += 1;
        return ok({ accessToken: 'new-token' });
      }),
    );
    const { client, store } = setup();
    await expect(client.request({ method: 'GET', path: 'things' }, Thing)).resolves.toEqual({ id: 1 });
    expect(refreshes).toBe(0);
  });

  it('should retry only once: a second AUTH-002 is returned to the caller', async () => {
    let refreshes = 0;
    server.use(
      http.get(url('things'), () => fail(401, 'AUTH-002')),
      http.post(url('auth/refresh'), () => {
        refreshes += 1;
        return ok({ accessToken: `token-${refreshes}` });
      }),
    );
    expect(await rejection(setup().client.request({ method: 'GET', path: 'things' }))).toMatchObject({ code: 'AUTH-002' });
    expect(refreshes).toBe(1);
  });

  it.each([
    [401, 'AUTH-005'],
    [403, 'AUTH-006'],
  ])('should end the session when refresh is refused (%i %s): clear the token, call onAuthFailure once, reject every queued request', async (status, code) => {
    server.use(protectedResource(), http.post(url('auth/refresh'), () => fail(status, code)));
    const { client, store, onAuthFailure } = setup();
    const errors = await Promise.all([1, 2, 3].map(() => rejection(client.request({ method: 'GET', path: 'things' }))));

    expect(errors.map((error) => error.code)).toEqual([code, code, code]);
    expect(store.token).toBeNull();
    expect(onAuthFailure).toHaveBeenCalledTimes(1);
    expect(onAuthFailure.mock.calls[0]?.[0]).toMatchObject({ code, status });
  });

  it('should keep the session when refresh fails for a temporary reason (offline, 5xx)', async () => {
    server.use(protectedResource(), http.post(url('auth/refresh'), () => HttpResponse.error()));
    const { client, store, onAuthFailure } = setup();
    expect(await rejection(client.request({ method: 'GET', path: 'things' }))).toMatchObject({ code: 'SYS-002' });
    expect(store.token).toBe('old-token');
    expect(onAuthFailure).not.toHaveBeenCalled();
  });

  it('should reject a refresh answer without an access token', async () => {
    server.use(http.post(url('auth/refresh'), () => ok({})));
    const { client, setToken } = setup();
    expect(await rejection(client.refresh())).toMatchObject({ code: 'SYS-001' });
    expect(setToken).not.toHaveBeenCalled();
  });

  it('should start a new refresh after the previous one settled', async () => {
    let refreshes = 0;
    server.use(
      http.post(url('auth/refresh'), () => {
        refreshes += 1;
        return ok({ accessToken: `token-${refreshes}` });
      }),
    );
    const { client, store } = setup();
    await client.refresh();
    await client.refresh();
    expect(refreshes).toBe(2);
    expect(store.token).toBe('token-2');
  });

  it.each([
    ['portal', 'portal/auth/refresh'],
    ['admin', 'admin/auth/refresh'],
  ] as const)('should use the %s realm refresh endpoint', async (realm, path) => {
    server.use(http.post(url(path), () => ok({ accessToken: 'realm-token' })));
    const { client, store } = setup(realm);
    await client.refresh();
    expect(store.token).toBe('realm-token');
  });

  it('should serialise refreshes across tabs through a Web Lock named for the realm', async () => {
    server.use(http.post(url('portal/auth/refresh'), () => ok({ accessToken: 'locked-token' })));
    const names: string[] = [];
    const locks = { request: vi.fn(async (name: string, run: () => Promise<unknown>) => (names.push(name), run())) };
    vi.stubGlobal('navigator', { locks });
    try {
      const { client, store } = setup('portal');
      await client.refresh();
      expect(names).toEqual(['nlq-refresh-portal']);
      expect(store.token).toBe('locked-token');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('idempotencyHeaders', () => {
  it('should create a random key, or reuse the one given for a retried action', () => {
    const first = idempotencyHeaders()[IDEMPOTENCY_HEADER];
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(idempotencyHeaders()[IDEMPOTENCY_HEADER]).not.toBe(first);
    expect(idempotencyHeaders('action-1')).toEqual({ 'Idempotency-Key': 'action-1' });
  });
});

describe('token storage (D-050)', () => {
  it('should never touch web storage or cookies from code', () => {
    const sources = ['api-client.ts', 'api-error.ts', 'resources.ts'].map((file) => readFileSync(new URL(file, import.meta.url), 'utf8'));
    for (const source of sources) {
      expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/);
    }
  });
});
