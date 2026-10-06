import { readdirSync, readFileSync } from 'node:fs';
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
afterEach(() => {
  server.resetHandlers();
  vi.unstubAllGlobals();
});
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

/** Records the lock names a stubbed Web Locks API is asked for. */
function stubLocks(): string[] {
  const names: string[] = [];
  vi.stubGlobal('navigator', {
    locks: {
      request: async (name: string, run: () => Promise<unknown>) => {
        names.push(name);
        return run();
      },
    },
  });
  return names;
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

  it('should never send a request (or the token) to another host, whatever the path', async () => {
    let target = '';
    server.use(
      http.all(`${ORIGIN}/*`, ({ request }) => {
        target = request.url;
        return ok(null);
      }),
    );
    await setup('office', 'new-token').client.request({ method: 'GET', path: 'https://evil.test/x' });
    expect(new URL(target).origin).toBe(ORIGIN);
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

  it('should take the request id from the header when the error envelope has none', async () => {
    server.use(
      http.get(url('things'), () =>
        HttpResponse.json(
          { success: false, error: { code: 'RES-001', message: 'Not found' } },
          { status: 404, headers: { 'x-request-id': 'req-header-1' } },
        ),
      ),
    );
    expect(await rejection(setup().client.request({ method: 'GET', path: 'things' }))).toMatchObject({
      code: 'RES-001',
      requestId: 'req-header-1',
      details: [],
    });
  });

  it('should pass the Retry-After seconds of a 429 on', async () => {
    server.use(
      http.post(url('auth/login'), () =>
        HttpResponse.json({ success: false, error: { code: 'RATE-001', message: 'Too many' }, meta }, { status: 429, headers: { 'retry-after': '42' } }),
      ),
    );
    expect(await rejection(setup().client.request({ method: 'POST', path: 'auth/login' }))).toMatchObject({ code: 'RATE-001', retryAfter: 42 });
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
      http.get(url('failed'), () => HttpResponse.json({ success: false })),
      http.get(url('empty'), () => new HttpResponse(null, { status: 204 })),
      http.get(url('things'), () => ok({ id: 'one' })),
    );
    const { client } = setup('office', 'new-token');
    expect(await rejection(client.request({ method: 'GET', path: 'plain' }, Thing))).toMatchObject({ code: 'SYS-001', status: 200 });
    expect(await rejection(client.request({ method: 'GET', path: 'plain' }))).toMatchObject({ code: 'SYS-001', status: 200 });
    expect(await rejection(client.request({ method: 'GET', path: 'failed' }))).toMatchObject({ code: 'SYS-001', status: 200 });
    expect(await rejection(client.request({ method: 'GET', path: 'empty' }, Thing))).toMatchObject({ code: 'SYS-001', status: 204 });
    expect(await rejection(client.request({ method: 'GET', path: 'things' }, Thing))).toMatchObject({ code: 'SYS-001', requestId: 'req-12345678' });
  });

  it('should never put response values in a contract-mismatch message', async () => {
    server.use(http.get(url('things'), () => ok({ id: 'secret-value' })));
    const error = await rejection(setup('office', 'new-token').client.request({ method: 'GET', path: 'things' }, Thing));
    expect(error.message).toContain('id: invalid_type');
    expect(error.message).not.toContain('secret-value');
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
    // The refresh answers only once all five requests have had their 401, so every one of them must join it.
    const allRejected = vi.waitFor(() => expect(seen.filter((auth) => auth === 'Bearer old-token')).toHaveLength(5));
    server.use(
      protectedResource(seen),
      http.post(url('auth/refresh'), async ({ request }) => {
        refreshes += 1;
        refreshHeaders = request.headers;
        await allRejected;
        return ok({ accessToken: 'new-token', expiresIn: 900 });
      }),
    );
    const { client, store, onAuthFailure } = setup();
    const results = await Promise.all(Array.from({ length: 5 }, () => client.request({ method: 'GET', path: 'things' }, Thing)));

    expect(results).toEqual(Array.from({ length: 5 }, () => ({ id: 1 })));
    expect(refreshes).toBe(1);
    expect(seen.filter((auth) => auth === 'Bearer new-token')).toHaveLength(5);
    expect(store.token).toBe('new-token');
    expect(onAuthFailure).not.toHaveBeenCalled();
    // The refresh itself carries no bearer token, only the cookie and the CSRF header.
    expect(refreshHeaders?.get('authorization')).toBeNull();
    expect(refreshHeaders?.get('x-requested-with')).toBe('XMLHttpRequest');
  });

  it('should retry without refreshing again when another refresh already replaced the token', async () => {
    let refreshes = 0;
    const seen: string[] = [];
    server.use(
      http.get(url('things'), ({ request }) => {
        seen.push(request.headers.get('authorization') ?? '');
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
    expect(seen).toEqual(['Bearer old-token', 'Bearer new-token']);
  });

  it('should not retry without a token when the session ended while the request was on its way', async () => {
    let refreshes = 0;
    let calls = 0;
    server.use(
      http.get(url('things'), () => {
        calls += 1;
        // A refresh refused meanwhile has cleared the token.
        store.token = null;
        return fail(401, 'AUTH-002');
      }),
      http.post(url('auth/refresh'), () => {
        refreshes += 1;
        return ok({ accessToken: 'new-token' });
      }),
    );
    const { client, store } = setup();
    expect(await rejection(client.request({ method: 'GET', path: 'things' }))).toMatchObject({ code: 'AUTH-002' });
    expect({ calls, refreshes }).toEqual({ calls: 1, refreshes: 0 });
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
    [401, 'AUTH-001'],
    [401, 'AUTH-003'],
    [401, 'AUTH-005'],
    [403, 'AUTH-100'],
  ])('should not refresh on %i %s, only on AUTH-002', async (status, code) => {
    let refreshes = 0;
    server.use(
      http.get(url('things'), () => fail(status, code)),
      http.post(url('auth/refresh'), () => {
        refreshes += 1;
        return ok({ accessToken: 'new-token' });
      }),
    );
    expect(await rejection(setup().client.request({ method: 'GET', path: 'things' }))).toMatchObject({ code, status });
    expect(refreshes).toBe(0);
  });

  it.each([
    [401, 'AUTH-005'],
    [403, 'AUTH-006'],
    [403, 'AUTH-010'],
  ])('should end the session when refresh is refused (%i %s): clear the token, call onAuthFailure once, reject every queued request', async (status, code) => {
    server.use(protectedResource(), http.post(url('auth/refresh'), () => fail(status, code)));
    const { client, store, onAuthFailure } = setup();
    const errors = await Promise.all([1, 2, 3].map(() => rejection(client.request({ method: 'GET', path: 'things' }))));

    expect(errors.map((error) => error.code)).toEqual([code, code, code]);
    expect(store.token).toBeNull();
    expect(onAuthFailure).toHaveBeenCalledTimes(1);
    expect(onAuthFailure.mock.calls[0]?.[0]).toMatchObject({ code, status });
  });

  it('should keep the session when refresh is refused by the CSRF check (403 AUTH-100: the server keeps the cookie)', async () => {
    server.use(protectedResource(), http.post(url('auth/refresh'), () => fail(403, 'AUTH-100')));
    const { client, store, onAuthFailure } = setup();
    expect(await rejection(client.request({ method: 'GET', path: 'things' }))).toMatchObject({ code: 'AUTH-100' });
    expect(store.token).toBe('old-token');
    expect(onAuthFailure).not.toHaveBeenCalled();
  });

  it('should clear the token but not call onAuthFailure when an explicit refresh (app start) is refused', async () => {
    server.use(http.post(url('auth/refresh'), () => fail(401, 'AUTH-005')));
    const { client, store, onAuthFailure } = setup();
    expect(await rejection(client.refresh())).toMatchObject({ code: 'AUTH-005' });
    expect(store.token).toBeNull();
    expect(onAuthFailure).not.toHaveBeenCalled();
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
    const names = stubLocks();
    const { client, store } = setup('portal');
    await client.refresh();
    expect(names).toEqual(['nlq-refresh-portal']);
    expect(store.token).toBe('locked-token');
  });
});

describe('sessionRequest', () => {
  it('should wait for a refresh in flight before signing out, so the rotated cookie is the one revoked', async () => {
    const order: string[] = [];
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.post(url('auth/refresh'), async () => {
        order.push('refresh:start');
        await released;
        order.push('refresh:end');
        return ok({ accessToken: 'new-token' });
      }),
      http.post(url('auth/logout'), () => {
        order.push('logout');
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const { client } = setup();
    const refreshed = client.refresh();
    await vi.waitFor(() => expect(order).toEqual(['refresh:start']));
    const loggedOut = client.sessionRequest({ method: 'POST', path: 'auth/logout' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual(['refresh:start']);
    release();
    await Promise.all([refreshed, loggedOut]);
    expect(order).toEqual(['refresh:start', 'refresh:end', 'logout']);
  });

  it('should hold the cross-tab refresh lock and never refresh itself', async () => {
    let refreshes = 0;
    server.use(
      http.post(url('auth/login'), () => fail(401, 'AUTH-002')),
      http.post(url('auth/refresh'), () => {
        refreshes += 1;
        return ok({ accessToken: 'new-token' });
      }),
    );
    const names = stubLocks();
    expect(await rejection(setup('admin').client.sessionRequest({ method: 'POST', path: 'auth/login' }))).toMatchObject({ code: 'AUTH-002' });
    expect(refreshes).toBe(0);
    expect(names).toEqual(['nlq-refresh-admin']);
  });
});

describe('idempotencyHeaders', () => {
  it('should send the key of the user action', async () => {
    let key: string | null = null;
    server.use(
      http.post(url('invoices'), ({ request }) => {
        key = request.headers.get(IDEMPOTENCY_HEADER);
        return ok(null, 201);
      }),
    );
    await setup().client.request({ method: 'POST', path: 'invoices', headers: idempotencyHeaders('action-1') });
    expect(key).toBe('action-1');
  });
});

describe('token storage (D-050)', () => {
  it('should never touch web storage or cookies from code', () => {
    // A tripwire, not a proof: it catches the obvious ways of persisting the token.
    const dir = new URL('.', import.meta.url);
    const sources = readdirSync(dir)
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.spec.ts'))
      .map((file) => readFileSync(new URL(file, dir), 'utf8'));
    expect(sources.length).toBeGreaterThanOrEqual(4);
    for (const source of sources) {
      expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/);
    }
  });
});
