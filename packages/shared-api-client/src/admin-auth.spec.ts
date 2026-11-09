import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

import { adminAuthApi } from './admin-auth.js';
import { createApiClient } from './api-client.js';

const ORIGIN = 'http://api.test';
const url = (path: string) => `${ORIGIN}/api/v1/${path}`;
const meta = { timestamp: '2026-11-09T10:00:00.000Z', requestId: 'req-12345678' };
const ok = (data: unknown, status = 200) =>
  HttpResponse.json({ success: true, data, meta }, { status });

const admin = {
  id: '01920000-0000-7000-8000-000000000009',
  fullName: 'Founder',
  email: 'founder@example.test',
};
const session = { accessToken: 'admin-access', expiresIn: 900, admin };
const credentials = { email: 'founder@example.test', password: 'Testtesttest1' };

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function setup() {
  const store: { token: string | null } = { token: null };
  const client = createApiClient({
    baseURL: ORIGIN,
    realm: 'admin',
    getToken: () => store.token,
    setToken: (next) => {
      store.token = next;
    },
    onAuthFailure: vi.fn(),
  });
  return { auth: adminAuthApi(client), store };
}

describe('adminAuthApi', () => {
  it('should sign in, keep the token in the client and return the session without it', async () => {
    let body: unknown;
    server.use(
      http.post(url('admin/auth/login'), async ({ request }) => {
        body = await request.json();
        return ok(session);
      }),
    );
    const { auth, store } = setup();
    const result = await auth.login({ ...credentials, code: '123456' });
    expect(result).toEqual({ expiresIn: 900, admin });
    expect(store.token).toBe('admin-access');
    expect(body).toEqual({ ...credentials, code: '123456' });
  });

  it('should return the enrolment secret and then a session with the recovery codes', async () => {
    const codes = ['ABCDE-FGHIJ', 'KLMNO-PQRST'];
    server.use(
      http.post(url('admin/auth/enroll'), () =>
        ok({ otpauthUri: 'otpauth://totp/NexLegTiq:founder?secret=ABC', secret: 'ABC' }),
      ),
      http.post(url('admin/auth/enroll/confirm'), () =>
        ok({ ...session, recoveryCodes: codes }, 201),
      ),
    );
    const { auth, store } = setup();
    await expect(auth.enroll(credentials)).resolves.toMatchObject({ secret: 'ABC' });
    expect(store.token).toBeNull();
    const confirmed = await auth.confirmEnrollment({ ...credentials, code: '123456' });
    expect(confirmed.recoveryCodes).toEqual(codes);
    expect(store.token).toBe('admin-access');
  });

  it('should restore the session through the admin refresh path', async () => {
    server.use(http.post(url('admin/auth/refresh'), () => ok(session)));
    const { auth, store } = setup();
    await expect(auth.refresh()).resolves.toEqual({ expiresIn: 900, admin });
    expect(store.token).toBe('admin-access');
  });

  it('should clear the token on logout even when the server fails', async () => {
    server.use(
      http.post(url('admin/auth/login'), () => ok(session)),
      http.post(url('admin/auth/logout'), () => HttpResponse.error()),
    );
    const { auth, store } = setup();
    await auth.login({ ...credentials, code: '123456' });
    await expect(auth.logout()).rejects.toMatchObject({ code: 'SYS-002' });
    expect(store.token).toBeNull();
  });
});
