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
  const onAuthFailure = vi.fn();
  const client = createApiClient({
    baseURL: ORIGIN,
    realm: 'office',
    getToken: () => store.token,
    setToken: (next) => {
      store.token = next;
    },
    onAuthFailure,
  });
  return { auth: authApi(client), users: usersApi(client), store, onAuthFailure };
}

const registration = {
  fullName: 'Layla Haddad',
  email: 'layla@example.test',
  password: 'Testtesttest1',
  officeName: 'Haddad Law',
  accountType: 'FIRM',
  currency: 'ILS',
  acceptTerms: true,
  acceptPrivacy: true,
} as const;

describe('authApi', () => {
  it.each([
    ['login', { email: 'layla@example.test', password: 'Testtesttest1' }],
    ['register', registration],
  ] as const)('should %s, keep the access token in the client and return the session without it', async (call, input) => {
    let body: unknown;
    server.use(
      http.post(url(`auth/${call}`), async ({ request }) => {
        body = await request.json();
        return ok(session, call === 'register' ? 201 : 200);
      }),
    );
    const { auth, store } = setup();
    const result = call === 'login' ? await auth.login(input) : await auth.register(input as typeof registration);
    expect(result.user.role).toBe('OFFICE_MANAGER');
    expect(result).not.toHaveProperty('accessToken');
    expect(store.token).toBe('access-1');
    expect(body).toEqual(input);
  });

  it('should reject a session that breaks the contract without storing its token', async () => {
    server.use(http.post(url('auth/login'), () => ok({ accessToken: 'access-1' })));
    const { auth, store } = setup();
    await expect(auth.login({ email: 'layla@example.test', password: 'Testtesttest1' })).rejects.toMatchObject({ code: 'SYS-001' });
    expect(store.token).toBeNull();
  });

  it('should pass a refused login through and store nothing', async () => {
    server.use(http.post(url('auth/login'), () => HttpResponse.json({ success: false, error: { code: 'AUTH-007', message: 'Locked' }, meta }, { status: 423 })));
    const { auth, store, onAuthFailure } = setup();
    await expect(auth.login({ email: 'layla@example.test', password: 'Testtesttest1' })).rejects.toMatchObject({ code: 'AUTH-007', status: 423 });
    expect(store.token).toBeNull();
    expect(onAuthFailure).not.toHaveBeenCalled();
  });

  it('should restore the session from the refresh cookie', async () => {
    server.use(http.post(url('auth/refresh'), () => ok({ ...session, accessToken: 'access-2' })));
    const { auth, store } = setup();
    const restored = await auth.refresh();
    expect(restored).toMatchObject({ user: { officeName: 'Haddad Law' } });
    expect(restored).not.toHaveProperty('accessToken');
    expect(store.token).toBe('access-2');
  });

  it('should reject without onAuthFailure when there is no session to restore (public pages stay put)', async () => {
    server.use(http.post(url('auth/refresh'), () => HttpResponse.json({ success: false, error: { code: 'AUTH-005', message: 'No session' }, meta }, { status: 401 })));
    const { auth, onAuthFailure } = setup();
    await expect(auth.refresh()).rejects.toMatchObject({ code: 'AUTH-005' });
    expect(onAuthFailure).not.toHaveBeenCalled();
  });

  it('should turn a restored session that breaks the contract into SYS-001 and drop its token', async () => {
    server.use(http.post(url('auth/refresh'), () => ok({ accessToken: 'access-2' })));
    const { auth, store } = setup();
    await expect(auth.refresh()).rejects.toMatchObject({ code: 'SYS-001' });
    expect(store.token).toBeNull();
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
