import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

import { createApiClient } from './api-client.js';
import { portalApi, portalAuthApi } from './portal.js';

const ORIGIN = 'http://api.test';
const url = (path: string) => `${ORIGIN}/api/v1/${path}`;
const meta = { timestamp: '2026-11-21T10:00:00.000Z', requestId: 'req-12345678' };
const ok = (data: unknown, status = 200) =>
  HttpResponse.json({ success: true, data, meta }, { status });

const FILE_ID = '01920000-0000-7000-8000-000000000101';
const user = {
  id: '01920000-0000-7000-8000-000000000009',
  fullName: 'Layla',
  email: 'layla@example.test',
  offices: [
    {
      officeId: '01920000-0000-7000-8000-00000000000a',
      officeName: 'Office',
      officePhone: null,
      officeEmail: null,
      clientId: '01920000-0000-7000-8000-00000000000c',
      clientName: 'Layla',
    },
  ],
};
const session = { accessToken: 'portal-access', expiresIn: 900, user };

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function setup() {
  const store: { token: string | null } = { token: null };
  const client = createApiClient({
    baseURL: ORIGIN,
    realm: 'portal',
    getToken: () => store.token,
    setToken: (next) => {
      store.token = next;
    },
    onAuthFailure: vi.fn(),
  });
  return { auth: portalAuthApi(client), portal: portalApi(client), store };
}

describe('portalAuthApi', () => {
  it('should sign in, keep the token in the client and return the session without it', async () => {
    server.use(http.post(url('portal/auth/login'), () => ok(session)));
    const { auth, store } = setup();
    await expect(auth.login({ email: user.email, password: 'x' })).resolves.toEqual({
      expiresIn: 900,
      user,
    });
    expect(store.token).toBe('portal-access');
  });

  it('should restore the session from the portal refresh endpoint and clear the token on logout', async () => {
    server.use(
      http.post(url('portal/auth/refresh'), () => ok(session)),
      http.post(url('portal/auth/logout'), () => new HttpResponse(null, { status: 204 })),
    );
    const { auth, store } = setup();
    await expect(auth.refresh()).resolves.toMatchObject({ user });
    expect(store.token).toBe('portal-access');
    await auth.logout();
    expect(store.token).toBeNull();
  });
});

describe('portalApi', () => {
  it('should send an upload as multipart with its idempotency key', async () => {
    let key: string | null = null;
    let name: string | undefined;
    server.use(
      http.post(url(`portal/files/${FILE_ID}/uploads`), async ({ request }) => {
        key = request.headers.get('Idempotency-Key');
        name = ((await request.formData()).get('file') as File | null)?.name;
        return ok(
          {
            id: '01920000-0000-7000-8000-000000000201',
            fileId: FILE_ID,
            name: 'id.pdf',
            mimeType: 'application/pdf',
            sizeBytes: '10',
            status: 'SCANNING',
            rejectionReason: null,
            createdAt: '2026-11-21T10:00:00.000Z',
          },
          202,
        );
      }),
    );
    const { portal } = setup();
    const upload = await portal.upload(FILE_ID, new Blob(['%PDF']), 'id.pdf', {
      idempotencyKey: 'k-1',
    });
    expect(upload.status).toBe('SCANNING');
    expect(key).toBe('k-1');
    expect(name).toBe('id.pdf');
  });

  it('should tell a rendering invoice PDF from a ready one', async () => {
    server.use(http.get(url('portal/invoices/i-1/pdf'), () => ok({ status: 'RENDERING' }, 202)));
    const { portal } = setup();
    await expect(portal.invoicePdf('i-1')).resolves.toEqual({ status: 'RENDERING' });
  });
});
