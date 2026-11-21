import { RESOURCES } from '@nexlegtiq/shared-i18n';
import { cleanup, screen, waitFor } from '@testing-library/react';
import { http } from 'msw';
import { setupServer } from 'msw/node';

import { resetSession, usePortalSession } from './session';
import { APP_NAME } from '../../app/app-name';
import {
  SESSION,
  USER,
  api,
  click,
  expectAccessible,
  fail,
  ok,
  renderApp,
  type,
} from '../../test/render-app';

const ar = RESOURCES.ar;
const en = RESOURCES.en;
const t = (tree: unknown, path: string): string =>
  path
    .split('.')
    .reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], tree) as string;

const server = setupServer(
  http.post(api('portal/auth/refresh'), () => fail(401, 'AUTH-003')),
  http.get(api('portal/files'), () => ok([])),
);
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  resetSession();
  localStorage.clear();
});
afterAll(() => server.close());

describe('portal sign-in', () => {
  it('should be named NexLegTiq Portal', () => {
    expect(APP_NAME).toBe('NexLegTiq Portal');
  });

  it('should open in Arabic, right to left, and sign a client in to their files', async () => {
    let body: unknown;
    server.use(
      http.post(api('portal/auth/login'), async ({ request }) => {
        body = await request.json();
        return ok(SESSION);
      }),
    );
    const router = await renderApp('/');
    await screen.findByTestId('login-email');
    expect(document.documentElement.dir).toBe('rtl');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(t(ar, 'portal.login.title'));
    await expectAccessible();

    type('login-email', USER.email);
    type('login-password', 'Testtesttest1');
    click('login-submit');

    expect(await screen.findByTestId('portal-brand')).toHaveProperty(
      'textContent',
      USER.offices[0]?.officeName,
    );
    expect(router.state.location.pathname).toBe('/');
    expect(body).toEqual({ email: USER.email, password: 'Testtesttest1' });
    expect(usePortalSession.getState().accessToken).toBe('portal-access');
  });

  it('should show a refused sign-in without leaving the page', async () => {
    server.use(http.post(api('portal/auth/login'), () => fail(401, 'AUTH-001')));
    await renderApp('/login', 'en');
    await screen.findByTestId('login-email');
    expect(document.documentElement.dir).toBe('ltr');
    type('login-email', USER.email);
    type('login-password', 'wrong');
    click('login-submit');
    expect((await screen.findByTestId('login-error')).textContent).toContain(
      t(en, 'errors.AUTH-001'),
    );
  });

  it('should sign out and say so on the sign-in page', async () => {
    server.use(
      http.post(api('portal/auth/refresh'), () => ok(SESSION)),
      http.post(api('portal/auth/logout'), () => new Response(null, { status: 204 })),
    );
    const router = await renderApp('/', 'en');
    await screen.findByTestId('sign-out');
    click('sign-out');
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect((await screen.findByTestId('login-notice')).textContent).toBe(
      t(en, 'auth.notice.signedOut'),
    );
  });

  it('should offer a retry, not sign-in, when the session cannot be restored for an outage', async () => {
    server.use(http.post(api('portal/auth/refresh'), () => fail(503, 'SYS-002')));
    const router = await renderApp('/', 'en');
    expect(await screen.findByRole('button', { name: /retry|try again/i })).toBeTruthy();
    expect(router.state.location.pathname).toBe('/');
    expect(usePortalSession.getState().status).toBe('error');
  });

  it('should always confirm a forgot-password request', async () => {
    let body: unknown;
    server.use(
      http.post(api('portal/auth/forgot-password'), async ({ request }) => {
        body = await request.json();
        return ok();
      }),
    );
    await renderApp('/login', 'en');
    await screen.findByTestId('forgot-link');
    click('forgot-link');
    await screen.findByTestId('forgot-email');
    type('forgot-email', USER.email);
    click('forgot-submit');
    expect(await screen.findByTestId('forgot-sent')).toBeTruthy();
    expect(body).toEqual({ email: USER.email });
  });

  it('should reset the password from the emailed link and ask to sign in again', async () => {
    let body: unknown;
    server.use(
      http.post(api('portal/auth/reset-password'), async ({ request }) => {
        body = await request.json();
        return new Response(null, { status: 204 });
      }),
    );
    const router = await renderApp('/reset-password?token=reset-token-0123456789abcdef', 'en');
    await screen.findByTestId('reset-new-password');
    type('reset-new-password', 'Newpassword12');
    type('reset-confirm-password', 'Newpassword12');
    click('reset-submit');
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(body).toMatchObject({
      token: 'reset-token-0123456789abcdef',
      newPassword: 'Newpassword12',
    });
    expect((await screen.findByTestId('login-notice')).textContent).toBe(
      t(en, 'auth.notice.passwordReset'),
    );
  });
});

describe('portal invitation', () => {
  const preview = (accountExists: boolean) =>
    http.post(api('portal/auth/invites/preview'), () =>
      ok({
        officeName: 'مكتب العدالة',
        clientName: 'Layla Haddad',
        email: USER.email,
        accountExists,
        expiresAt: '2026-11-28T10:00:00.000Z',
      }),
    );

  it('should create the account with a name and a password, then open the files', async () => {
    let body: unknown;
    server.use(
      preview(false),
      http.post(api('portal/auth/accept-invite'), async ({ request }) => {
        body = await request.json();
        return ok(SESSION, 201);
      }),
    );
    const router = await renderApp('/accept-invite?token=invite-token-0123456789abcdef');
    expect((await screen.findByTestId('invite-intro')).textContent).toContain('مكتب العدالة');
    await expectAccessible();
    type('invite-full-name', 'Layla Haddad');
    type('invite-password', 'Testtesttest1');
    click('invite-accept-terms');
    click('invite-accept-privacy');
    click('invite-submit');
    await screen.findByTestId('portal-brand');
    expect(router.state.location.pathname).toBe('/');
    expect(body).toEqual({
      token: 'invite-token-0123456789abcdef',
      fullName: 'Layla Haddad',
      password: 'Testtesttest1',
      acceptTerms: true,
      acceptPrivacy: true,
    });
  });

  it('should ask an existing account for its password only', async () => {
    let body: unknown;
    server.use(
      preview(true),
      http.post(api('portal/auth/accept-invite'), async ({ request }) => {
        body = await request.json();
        return ok(SESSION, 201);
      }),
    );
    await renderApp('/accept-invite?token=invite-token-0123456789abcdef', 'en');
    await screen.findByTestId('invite-existing');
    expect(screen.queryByTestId('invite-full-name')).toBeNull();
    type('invite-password', 'old');
    click('invite-accept-terms');
    click('invite-accept-privacy');
    click('invite-submit');
    await screen.findByTestId('portal-brand');
    expect(body).toMatchObject({ fullName: 'Layla Haddad', password: 'old' });
  });

  it('should take the token out of the address bar at once', async () => {
    server.use(preview(false));
    const router = await renderApp('/accept-invite?token=invite-token-0123456789abcdef', 'en');
    await screen.findByTestId('invite-intro');
    expect(router.state.location.search).toBe('');
  });

  it('should explain a link that is no longer valid', async () => {
    server.use(http.post(api('portal/auth/invites/preview'), () => fail(410, 'RES-004')));
    await renderApp('/accept-invite?token=gone', 'en');
    expect((await screen.findByTestId('invite-invalid')).textContent).toContain(
      t(en, 'portal.acceptInvite.invalidBody'),
    );
  });
});
