import { fireEvent, screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';

import { api, fail, http, ok, renderApp, server, SESSION, signedIn, signedOut, USER, setupTestServer } from '../../test/render-app';
import { safeNext } from './forms';
import { queryClient, restoreSession, useSession } from './session';

setupTestServer();

const type = (testId: string, value: string) => fireEvent.change(screen.getByTestId(testId), { target: { value } });
/** Pages are lazy-loaded: wait until `testId` is on screen. */
const ready = (testId: string) => screen.findByTestId(testId);
const click = (testId: string) => fireEvent.click(screen.getByTestId(testId));

// jsdom has no layout, so colour contrast is checked in Storybook (D-088); landmarks belong to the app shell.
/** axe over a whole AntD form takes several seconds in jsdom. */
const A11Y_TIMEOUT_MS = 30_000;

async function expectAccessible(): Promise<void> {
  const { violations } = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
  expect(violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`)).toEqual([]);
}

describe('app start and guards', () => {
  it('should restore the session from the refresh cookie and show the signed-in page', async () => {
    server.use(http.post(api('auth/refresh'), () => ok(SESSION)));
    await restoreSession();
    renderApp('/');
    expect(await screen.findByTestId('home-page')).toBeTruthy();
    expect(screen.getByText('Layla Haddad').tagName).toBe('BDI');
    expect(useSession.getState().accessToken).toBe('access-1');
  });

  it('should send a visitor without a session to sign-in and back to the page they asked for', async () => {
    server.use(http.post(api('auth/refresh'), () => fail(401, 'AUTH-005')));
    await restoreSession();
    const { router } = renderApp('/?tab=1');
    expect(await screen.findByTestId('login-submit')).toBeTruthy();
    expect(router.state.location.pathname).toBe('/login');
    expect(new URLSearchParams(router.state.location.search).get('next')).toBe('/?tab=1');

    let body: unknown;
    server.use(
      http.post(api('auth/login'), async ({ request }) => {
        body = await request.json();
        return ok(SESSION);
      }),
    );
    type('login-email', ' Layla@Example.test ');
    type('login-password', 'Testtesttest1');
    click('login-submit');
    expect(await screen.findByTestId('home-page')).toBeTruthy();
    expect(router.state.location.search).toBe('?tab=1');
    expect(body).toEqual({ email: 'layla@example.test', password: 'Testtesttest1', rememberMe: false });
  });

  it('should show a loading state until the restore has answered', () => {
    renderApp('/');
    expect(screen.getByRole('status')).toBeTruthy();
  });

  it('should send a signed-in user away from the sign-in page', async () => {
    signedIn();
    const { router } = renderApp('/login?next=/');
    expect(await screen.findByTestId('home-page')).toBeTruthy();
    expect(router.state.location.pathname).toBe('/');
  });

  it.each(['//evil.test', 'https://evil.test', '/\\evil.test', ['javascript', 'alert(1)'].join(':'), null])('should never redirect off the app after sign-in (next=%s)', (next) => {
    expect(safeNext(next)).toBe('/');
  });

  it('should keep a same-app next path', () => {
    expect(safeNext('/cases/1?tab=documents')).toBe('/cases/1?tab=documents');
  });
});

describe('login page', () => {
  beforeEach(signedOut);

  it.each([
    [401, 'AUTH-001', 'en', 'The email or password is incorrect.'],
    [423, 'AUTH-007', 'en', 'Try again in 15 minutes'],
    [429, 'RATE-001', 'en', 'Too many requests'],
    [401, 'AUTH-001', 'ar', 'غير صحيح'],
  ] as const)('should show %i %s in %s as a translated message', async (status, code, locale, text) => {
    server.use(http.post(api('auth/login'), () => fail(status, code)));
    renderApp('/login', locale);
    await ready('login-email');
    type('login-email', 'layla@example.test');
    type('login-password', 'Testtesttest1');
    click('login-submit');
    expect((await screen.findByTestId('login-error')).textContent).toContain(text);
    expect(useSession.getState().status).toBe('anonymous');
  });

  it('should validate with the contract before calling the API', async () => {
    let called = false;
    server.use(
      http.post(api('auth/login'), () => {
        called = true;
        return ok(SESSION);
      }),
    );
    renderApp('/login');
    await ready('login-email');
    type('login-email', 'not-an-email');
    click('login-submit');
    expect(await screen.findByText('Enter a valid email address.')).toBeTruthy();
    expect(await screen.findByText('This field is required.')).toBeTruthy();
    expect(called).toBe(false);
  });

  it.each(['idle', 'expired', 'passwordReset'])('should explain why the user is here (%s)', async (reason) => {
    renderApp(`/login?reason=${reason}`);
    expect((await screen.findByTestId('login-notice')).textContent).not.toBe('');
  });

  it('should switch the page to English and back to Arabic', async () => {
    renderApp('/login', 'ar');
    expect((await screen.findByTestId('login-submit')).textContent).toBe('تسجيل الدخول');
    expect(document.documentElement.dir).toBe('rtl');
    fireEvent.click(screen.getByText('English'));
    await waitFor(() => expect(screen.getByTestId('login-submit').textContent).toBe('Sign in'));
    expect(document.documentElement.dir).toBe('ltr');
  });

  it.each(['ar', 'en'] as const)('should be accessible in %s', async (locale) => {
    renderApp('/login', locale);
    await screen.findByTestId('login-submit');
    await expectAccessible();
   }, A11Y_TIMEOUT_MS);
});

describe('signup page', () => {
  beforeEach(signedOut);

  const fill = () => {
    type('signup-full-name', 'Layla Haddad');
    type('signup-email', 'layla@example.test');
    type('signup-password', 'Testtesttest1');
    type('signup-office-name', 'Haddad Law');
  };

  it('should create the office with the contract defaults and sign the manager in', async () => {
    let body: unknown;
    server.use(
      http.post(api('auth/register'), async ({ request }) => {
        body = await request.json();
        return ok(SESSION, 201);
      }),
    );
    renderApp('/signup');
    await screen.findByTestId('signup-submit');
    fill();
    click('signup-accept-terms');
    click('signup-accept-privacy');
    click('signup-submit');
    expect(await screen.findByTestId('home-page')).toBeTruthy();
    expect(body).toEqual({
      fullName: 'Layla Haddad',
      email: 'layla@example.test',
      password: 'Testtesttest1',
      officeName: 'Haddad Law',
      accountType: 'FIRM',
      jurisdiction: 'PALESTINE',
      defaultLanguage: 'EN',
      currency: 'ILS',
      acceptTerms: true,
      acceptPrivacy: true,
    });
  });

  it('should require the Terms and Privacy boxes and a strong password', async () => {
    renderApp('/signup');
    await screen.findByTestId('signup-submit');
    fill();
    type('signup-password', 'short');
    click('signup-submit');
    expect(await screen.findByText('You must accept the Terms of Service.')).toBeTruthy();
    expect(screen.getByText('You must accept the Privacy Policy.')).toBeTruthy();
    expect(screen.getByText('Use at least 10 characters.')).toBeTruthy();
  });

  it('should put a taken email (409 RES-002) and server field errors where they belong', async () => {
    server.use(http.post(api('auth/register'), () => fail(400, 'VAL-001', [{ field: 'officeName', message: 'validation.invalidCharacters' }])));
    renderApp('/signup');
    await screen.findByTestId('signup-submit');
    fill();
    click('signup-accept-terms');
    click('signup-accept-privacy');
    click('signup-submit');
    expect(await screen.findByText('This contains characters that are not allowed.')).toBeTruthy();

    server.use(http.post(api('auth/register'), () => fail(409, 'RES-002')));
    click('signup-submit');
    expect((await screen.findByTestId('signup-error')).textContent).toContain('already');
  });

  it.each(['ar', 'en'] as const)('should be accessible in %s', async (locale) => {
    renderApp('/signup', locale);
    await screen.findByTestId('signup-submit');
    await expectAccessible();
   }, A11Y_TIMEOUT_MS);
});

describe('forgot and reset password', () => {
  beforeEach(signedOut);

  it('should give the same answer whatever the email', async () => {
    server.use(http.post(api('auth/forgot-password'), () => ok(null)));
    renderApp('/forgot-password', 'ar');
    await ready('forgot-email');
    type('forgot-email', 'someone@example.test');
    click('forgot-submit');
    expect((await screen.findByTestId('forgot-sent')).textContent).toContain('تحقّق من بريدك الإلكتروني');
  });

  it('should take the token out of the address bar, check that the passwords match and send the user to sign in', async () => {
    let body: unknown;
    server.use(
      http.post(api('auth/reset-password'), async ({ request }) => {
        body = await request.json();
        return new Response(null, { status: 204 });
      }),
    );
    const token = 'a'.repeat(43);
    const { router } = renderApp(`/reset-password?token=${token}`);
    await screen.findByTestId('reset-submit');
    await waitFor(() => expect(router.state.location.search).toBe(''));

    type('reset-new-password', 'Testtesttest1');
    type('reset-confirm-password', 'Testtesttest2');
    click('reset-submit');
    expect(await screen.findByText('The passwords do not match.')).toBeTruthy();

    type('reset-confirm-password', 'Testtesttest1');
    click('reset-submit');
    expect(await screen.findByTestId('login-notice')).toBeTruthy();
    expect(body).toEqual({ token, newPassword: 'Testtesttest1', confirmPassword: 'Testtesttest1' });
  });

  it.each([
    ['a used or expired link (410 RES-004)', `/reset-password?token=${'b'.repeat(43)}`],
    ['no token at all', '/reset-password'],
  ])('should offer a new link for %s', async (_case, path) => {
    server.use(http.post(api('auth/reset-password'), () => fail(410, 'RES-004')));
    renderApp(path);
    if (path.includes('token')) {
      await screen.findByTestId('reset-submit');
      type('reset-new-password', 'Testtesttest1');
      type('reset-confirm-password', 'Testtesttest1');
      click('reset-submit');
    }
    expect(await screen.findByTestId('reset-invalid')).toBeTruthy();
    expect(screen.getByTestId('reset-request-new').getAttribute('href')).toBe('/forgot-password');
  });
});

describe('verify email', () => {
  it('should confirm the email once and mark the signed-in user verified', async () => {
    let calls = 0;
    server.use(
      http.post(api('auth/verify-email'), () => {
        calls += 1;
        return new Response(null, { status: 204 });
      }),
    );
    signedIn({ emailVerified: false, verifyBy: '2026-10-12T10:00:00.000Z' });
    const { router } = renderApp(`/verify-email?token=${'c'.repeat(43)}`);
    expect(await screen.findByTestId('verify-success')).toBeTruthy();
    expect(calls).toBe(1);
    expect(router.state.location.search).toBe('');
    expect(useSession.getState().user).toMatchObject({ emailVerified: true, verifyBy: null });
  });

  it('should offer a new link when the link is no longer valid', async () => {
    signedOut();
    let resent: unknown;
    server.use(
      http.post(api('auth/verify-email'), () => fail(410, 'RES-004')),
      http.post(api('auth/resend-verification'), async ({ request }) => {
        resent = await request.json();
        return ok(null, 202);
      }),
    );
    renderApp(`/verify-email?token=${'d'.repeat(43)}`);
    expect(await screen.findByTestId('verify-invalid')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    type('verify-email', 'layla@example.test');
    click('verify-resend');
    expect(await screen.findByTestId('verify-resent')).toBeTruthy();
    expect(resent).toEqual({ email: 'layla@example.test' });
  });
});

describe('sign out', () => {
  it('should sign out on the server and clear the session and every cached query', async () => {
    let loggedOut = false;
    server.use(
      http.post(api('auth/logout'), () => {
        loggedOut = true;
        return new Response(null, { status: 204 });
      }),
    );
    signedIn();
    queryClient.setQueryData(['cases'], [{ id: 1 }]);
    const { router } = renderApp('/');
    click('sign-out');
    expect(await screen.findByTestId('login-notice')).toBeTruthy();
    expect(loggedOut).toBe(true);
    expect(router.state.location.pathname).toBe('/login');
    expect(useSession.getState()).toMatchObject({ status: 'anonymous', user: null, accessToken: null });
    expect(queryClient.getQueryData(['cases'])).toBeUndefined();
  });

  it('should still sign out locally when the server cannot be reached', async () => {
    server.use(http.post(api('auth/logout'), () => Response.error()));
    signedIn();
    renderApp('/');
    click('sign-out');
    expect(await screen.findByTestId('login-submit')).toBeTruthy();
    expect(useSession.getState().accessToken).toBeNull();
  });

  it('should send the user to sign-in with a notice when the session is lost mid-use', async () => {
    signedIn();
    renderApp('/');
    await screen.findByTestId('home-page');
    const { endSession } = await import('./session');
    endSession('expired');
    expect((await screen.findByTestId('login-notice')).textContent).toContain('Your session has ended');
  });

  it('should adopt the signed-in user language', async () => {
    signedIn({ uiLanguage: 'AR' });
    renderApp('/', 'en');
    expect((await screen.findByTestId('sign-out')).textContent).toBe('تسجيل الخروج');
    expect(USER.uiLanguage).toBe('EN');
  });
});
