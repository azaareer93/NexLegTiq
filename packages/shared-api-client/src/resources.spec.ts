import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

import { createApiClient } from './api-client.js';
import { authApi, usersApi } from './resources.js';

const ORIGIN = 'http://api.test';
const url = (path: string) => `${ORIGIN}/api/v1/${path}`;
const meta = { timestamp: '2026-10-05T10:00:00.000Z', requestId: 'req-12345678' };
const ok = (data: unknown, status = 200) => HttpResponse.json({ success: true, data, meta }, { status });

const session = {
  accessToken: 'access-1',
  expiresIn: 900,
  user: {
    id: '01920000-0000-7000-8000-000000000001',
    fullName: 'Layla Haddad',
    email: 'layla@example.test',
    role: 'OFFICE_MANAGER',
    officeId: '01920000-0000-7000-8000-000000000002',
    officeName: 'Haddad Law',
    uiLanguage: 'AR',
    permissions: ['create:case'],
    emailVerified: true,
    verifyBy: null,
  },
};

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function setup(token: string | null = null) {
  const store = { token };
  const client = createApiClient({
    baseURL: ORIGIN,
    realm: 'office',
    getToken: () => store.token,
    setToken: (next) => {
      store.token = next;
    },
    onAuthFailure: vi.fn(),
  });
  return { auth: authApi(client), users: usersApi(client), store };
}

describe('authApi', () => {
  it.each(['login', 'register'] as const)('should %s, store the access token and return the typed session', async (call) => {
    let body: unknown;
    server.use(
      http.post(url(`auth/${call}`), async ({ request }) => {
        body = await request.json();
        return ok(session, call === 'register' ? 201 : 200);
      }),
    );
    const { auth, store } = setup();
    const input = { email: 'layla@example.test', password: 'Testtesttest1' };
    const result = call === 'login' ? await auth.login(input) : await auth.register(input as never);
    expect(result.user.role).toBe('OFFICE_MANAGER');
    expect(store.token).toBe('access-1');
    expect(body).toEqual(input);
  });

  it('should restore the session from the refresh cookie', async () => {
    server.use(http.post(url('auth/refresh'), () => ok({ ...session, accessToken: 'access-2' })));
    const { auth, store } = setup();
    await expect(auth.refresh()).resolves.toMatchObject({ accessToken: 'access-2', user: { officeName: 'Haddad Law' } });
    expect(store.token).toBe('access-2');
  });

  it('should clear the token on logout, also when the server cannot be reached', async () => {
    server.use(http.post(url('auth/logout'), () => new HttpResponse(null, { status: 204 })));
    const { auth, store } = setup('access-1');
    await auth.logout();
    expect(store.token).toBeNull();

    server.use(http.post(url('auth/logout'), () => HttpResponse.error()));
    store.token = 'access-1';
    await expect(auth.logout()).rejects.toMatchObject({ code: 'SYS-002' });
    expect(store.token).toBeNull();
  });

  it.each([
    ['verifyEmail', 'auth/verify-email', { token: 'a'.repeat(43) }, 204],
    ['resendVerification', 'auth/resend-verification', { email: 'layla@example.test' }, 202],
    ['forgotPassword', 'auth/forgot-password', { email: 'layla@example.test' }, 200],
    ['resetPassword', 'auth/reset-password', { token: 'a'.repeat(43), newPassword: 'Testtesttest1', confirmPassword: 'Testtesttest1' }, 204],
  ] as const)('should call %s on %s', async (call, path, input, status) => {
    let body: unknown;
    server.use(
      http.post(url(path), async ({ request }) => {
        body = await request.json();
        return status === 204 ? new HttpResponse(null, { status }) : ok(null, status);
      }),
    );
    const { auth } = setup();
    await expect((auth[call] as (body: unknown) => Promise<void>)(input)).resolves.toBeUndefined();
    expect(body).toEqual(input);
  });
});

describe('usersApi', () => {
  it('should change the password with the bearer token', async () => {
    let authorization: string | null = null;
    server.use(
      http.post(url('users/me/password'), ({ request }) => {
        authorization = request.headers.get('authorization');
        return new HttpResponse(null, { status: 204 });
      }),
    );
    await expect(setup('access-1').users.changePassword({ currentPassword: 'Testtesttest1', newPassword: 'Testtesttest2' })).resolves.toBeUndefined();
    expect(authorization).toBe('Bearer access-1');
  });
});
