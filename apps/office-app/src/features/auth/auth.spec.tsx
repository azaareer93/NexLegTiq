import { fireEvent, screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { HttpResponse } from 'msw';

import { api, fail, http, listenToOtherTabs, ok, renderApp, server, SESSION, setupTestServer, signedIn, signedOut, setViewport, signOutFromMenu, USER } from '../../test/render-app';
import { safeNext } from './forms';
import { apiClient, queryClient, restoreSession, signOut, useSession } from './session';

setupTestServer();

const type = (testId: string, value: string) => fireEvent.change(screen.getByTestId(testId), { target: { value } });
const click = (testId: string) => fireEvent.click(screen.getByTestId(testId));
/** Pages are lazy-loaded: wait until `testId` is on screen. */
const ready = (testId: string) => screen.findByTestId(testId);
const noContent = () => new HttpResponse(null, { status: 204 });

/** axe over a whole AntD form takes several seconds in jsdom. */
const A11Y_TIMEOUT_MS = 60_000;

// jsdom has no layout, so colour contrast is checked in Storybook (D-088); landmarks belong to the app shell.
async function expectAccessible(): Promise<void> {
  const { violations } = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
  expect(violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`)).toEqual([]);
}

async function signIn(): Promise<void> {
  await ready('login-email');
  type('login-email', 'layla@example.test');
  type('login-password', 'Testtesttest1');
  click('login-submit');
}

describe('app start and guards', () => {
  it('should restore the session from the refresh cookie and show the signed-in page', async () => {
    server.use(http.post(api('auth/refresh'), () => ok(SESSION)));
    await restoreSession();
    setViewport(1280);
    renderApp('/');
    expect(await screen.findByTestId('page-dashboard')).toBeTruthy();
    expect((await screen.findByText('Layla Haddad')).tagName).toBe('BDI');
    expect(useSession.getState().accessToken).toBe('access-1');
  });

  it('should send a visitor without a session to sign-in and back to the page they asked for', async () => {
    server.use(http.post(api('auth/refresh'), () => fail(401, 'AUTH-005')));
    await restoreSession();
    const { router } = renderApp('/?tab=1');
    expect(await ready('login-submit')).toBeTruthy();
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
    click('login-remember');
    click('login-submit');
    expect(await screen.findByTestId('page-dashboard')).toBeTruthy();
    expect(router.state.location.search).toBe('?tab=1');
    expect(body).toEqual({ email: 'layla@example.test', password: 'Testtesttest1', rememberMe: true });
  });

  it('should not take a failure to reach the API at start for "signed out", and let the user retry', async () => {
    server.use(http.post(api('auth/refresh'), () => HttpResponse.error()));
    await restoreSession();
    expect(useSession.getState().status).toBe('error');
    renderApp('/');
    expect(await screen.findByRole('alert')).toBeTruthy();

    server.use(http.post(api('auth/refresh'), () => ok(SESSION)));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId('page-dashboard')).toBeTruthy();
  });

  it('should end a session left idle longer than the timeout, even after the tab was closed', async () => {
    let refreshed = false;
    let loggedOut = false;
    server.use(
      http.post(api('auth/refresh'), () => {
        refreshed = true;
        return ok(SESSION);
      }),
      http.post(api('auth/logout'), () => {
        loggedOut = true;
        return noContent();
      }),
    );
    localStorage.setItem('nlq.lastActivity', String(Date.now() - 31 * 60_000));
    await restoreSession();
    expect({ refreshed, loggedOut }).toEqual({ refreshed: false, loggedOut: true });
    renderApp('/');
    expect((await ready('login-notice')).textContent).toBe('You were signed out after a period of inactivity.');
  });

  it('should resume a session used recently, and forget the activity time on sign-out', async () => {
    server.use(http.post(api('auth/refresh'), () => ok(SESSION)), http.post(api('auth/logout'), noContent));
    localStorage.setItem('nlq.lastActivity', String(Date.now() - 5 * 60_000));
    await restoreSession();
    expect(useSession.getState().status).toBe('authenticated');
    expect(Number(localStorage.getItem('nlq.lastActivity'))).toBeGreaterThan(Date.now() - 1000);

    await signOut();
    expect(localStorage.getItem('nlq.lastActivity')).toBeNull();
  });

  it('should show a loading state until the restore has answered', async () => {
    renderApp('/');
    expect(await screen.findByRole('status')).toBeTruthy();
  });

  it('should send a signed-in user away from the sign-in page, to a safe next page', async () => {
    signedIn();
    const { router } = renderApp('/login?next=%2F%3Ftab%3D1');
    expect(await screen.findByTestId('page-dashboard')).toBeTruthy();
    expect(router.state.location.search).toBe('?tab=1');
  });

  it.each(['//evil.test', 'https://evil.test', '/\\evil.test', '/\t/evil.test', '/\n/evil.test', ['javascript', 'alert(1)'].join(':'), null])(
    'should never redirect off the app after sign-in (next=%j)',
    (next) => {
      expect(safeNext(next)).toBe('/');
    },
  );

  it('should keep a same-app next path', () => {
    expect(safeNext('/cases/1?tab=documents#top')).toBe('/cases/1?tab=documents#top');
  });

  it.each(['//evil.test', '/\t/evil.test'])('should land on the home page after signing in with next=%j', async (next) => {
    signedOut();
    server.use(http.post(api('auth/login'), () => ok(SESSION)));
    const { router } = renderApp(`/login?next=${encodeURIComponent(next)}`);
    await signIn();
    expect(await screen.findByTestId('page-dashboard')).toBeTruthy();
    expect(router.state.location.pathname).toBe('/');
  });
});

describe('login page', () => {
  beforeEach(signedOut);

  it.each([
    [401, 'AUTH-001', 'en', 'The email or password is incorrect.'],
    [423, 'AUTH-007', 'en', 'Too many failed attempts. Try again in 15 minutes.'],
    [401, 'AUTH-001', 'ar', 'البريد الإلكتروني أو كلمة المرور غير صحيحة.'],
  ] as const)('should show %i %s in %s as a translated message', async (status, code, locale, text) => {
    server.use(http.post(api('auth/login'), () => fail(status, code)));
    renderApp('/login', locale);
    await signIn();
    expect((await ready('login-error')).textContent).toBe(text);
    expect(useSession.getState().status).toBe('anonymous');
  });

  it.each([
    ['en', 'Try again in 42 seconds.'],
    ['ar', 'يمكنك المحاولة مجددًا بعد 42 ثانية.'],
  ] as const)('should say how long to wait after too many requests (%s)', async (locale, text) => {
    server.use(
      http.post(api('auth/login'), () =>
        HttpResponse.json(
          { success: false, error: { code: 'RATE-001', message: 'dev' }, meta: { timestamp: '', requestId: 'req-12345678' } },
          { status: 429, headers: { 'retry-after': '42' } },
        ),
      ),
    );
    renderApp('/login', locale);
    await signIn();
    expect((await ready('login-error')).textContent).toContain(text);
  });

  it('should give a support reference when the server failed', async () => {
    server.use(
      http.post(api('auth/login'), () =>
        HttpResponse.json({ success: false, error: { code: 'SYS-001', message: 'dev' }, meta: { timestamp: '', requestId: 'req-12345678' } }, { status: 500 }),
      ),
    );
    renderApp('/login', 'en');
    await signIn();
    expect((await ready('login-error')).textContent).toContain('req-12345678');
  });

  it('should warn while offline', async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
    try {
      renderApp('/login', 'en');
      expect(await ready('offline-banner')).toBeTruthy();
    } finally {
      Reflect.deleteProperty(navigator, 'onLine');
    }
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
    expect(screen.getAllByText('This field is required.')).toHaveLength(1);
    expect(called).toBe(false);
  });

  it.each([
    ['idle', 'You were signed out after a period of inactivity.'],
    ['expired', 'Your session has ended. Please sign in again.'],
    ['signedOut', 'You have been signed out.'],
    ['passwordReset', 'Your password has been changed. Sign in with the new password.'],
  ])('should explain why the user is here (%s)', async (reason, text) => {
    renderApp(`/login?reason=${reason}`);
    expect((await ready('login-notice')).textContent).toBe(text);
  });

  it('should switch the page to English and back to Arabic', async () => {
    renderApp('/login', 'ar');
    expect((await ready('login-submit')).textContent).toBe('تسجيل الدخول');
    expect(document.documentElement.dir).toBe('rtl');
    fireEvent.click(screen.getByText('English'));
    await waitFor(() => expect(screen.getByTestId('login-submit').textContent).toBe('Sign in'));
    expect(document.documentElement.dir).toBe('ltr');
  });

  it.each(['ar', 'en'] as const)(
    'should be accessible in %s',
    async (locale) => {
      renderApp('/login', locale);
      await ready('login-submit');
      await expectAccessible();
    },
    A11Y_TIMEOUT_MS,
  );
});

describe('signup page', () => {
  beforeEach(signedOut);

  const fill = () => {
    type('signup-full-name', 'Layla Haddad');
    type('signup-email', 'layla@example.test');
    type('signup-password', 'Testtesttest1');
    type('signup-office-name', 'Haddad Law');
  };
  const accept = () => {
    click('signup-accept-terms');
    click('signup-accept-privacy');
  };

  it.each([
    ['en', 'EN'],
    ['ar', 'AR'],
  ] as const)('should create the office (%s page, office language %s) and sign the manager in', async (locale, defaultLanguage) => {
    let body: unknown;
    server.use(
      http.post(api('auth/register'), async ({ request }) => {
        body = await request.json();
        return ok(SESSION, 201);
      }),
    );
    renderApp('/signup', locale);
    await ready('signup-submit');
    fill();
    accept();
    click('signup-submit');
    expect(await screen.findByTestId('page-dashboard')).toBeTruthy();
    expect(body).toEqual({
      fullName: 'Layla Haddad',
      email: 'layla@example.test',
      password: 'Testtesttest1',
      officeName: 'Haddad Law',
      accountType: 'FIRM',
      jurisdiction: 'PALESTINE',
      defaultLanguage,
      currency: 'ILS',
      acceptTerms: true,
      acceptPrivacy: true,
    });
  });

  it('should set the office language from the AR | EN switch until the user picks one', async () => {
    let body: { defaultLanguage?: string } = {};
    server.use(
      http.post(api('auth/register'), async ({ request }) => {
        body = (await request.json()) as typeof body;
        return ok(SESSION, 201);
      }),
    );
    renderApp('/signup', 'en');
    await ready('signup-submit');
    fireEvent.click(screen.getByText('العربية'));
    await waitFor(() => expect(screen.getByTestId('signup-submit').textContent).toBe('إنشاء الحساب'));
    fill();
    accept();
    click('signup-submit');
    expect(await screen.findByTestId('page-dashboard')).toBeTruthy();
    expect(body.defaultLanguage).toBe('AR');
  });

  it('should require the Terms and Privacy boxes, in Arabic too', async () => {
    renderApp('/signup', 'ar');
    await ready('signup-submit');
    fill();
    click('signup-submit');
    expect(await screen.findByText('يجب الموافقة على شروط الخدمة.')).toBeTruthy();
    expect(screen.getByText('يجب الموافقة على سياسة الخصوصية.')).toBeTruthy();
  });

  it('should require a strong password', async () => {
    renderApp('/signup');
    await ready('signup-submit');
    fill();
    type('signup-password', 'short');
    click('signup-submit');
    expect(await screen.findByText('Use at least 10 characters.')).toBeTruthy();
  });

  it('should put server field errors on their field, and explain a taken email', async () => {
    server.use(http.post(api('auth/register'), () => fail(400, 'VAL-001', [{ field: 'officeName', message: 'validation.invalidCharacters' }])));
    renderApp('/signup');
    await ready('signup-submit');
    fill();
    accept();
    click('signup-submit');
    const fieldError = await screen.findByText('This contains characters that are not allowed.');
    expect(fieldError.closest('.ant-form-item')?.querySelector('[data-testid="signup-office-name"]')).not.toBeNull();
    expect(screen.queryByTestId('signup-error')).toBeNull();

    server.use(http.post(api('auth/register'), () => fail(409, 'RES-002')));
    click('signup-submit');
    expect((await ready('signup-error')).textContent).toContain('This already exists.');
    expect(screen.getByTestId('signup-error-login').getAttribute('href')).toBe('/login');
  });

  it('should offer sign-in after a server error, as the office may exist already (D-083)', async () => {
    server.use(http.post(api('auth/register'), () => fail(500, 'SYS-001')));
    renderApp('/signup');
    await ready('signup-submit');
    fill();
    accept();
    click('signup-submit');
    expect((await ready('signup-error-login')).textContent).toBe('Your office may already have been created. Try signing in.');
  });

  it.each(['ar', 'en'] as const)(
    'should be accessible in %s',
    async (locale) => {
      renderApp('/signup', locale);
      await ready('signup-submit');
      await expectAccessible();
    },
    A11Y_TIMEOUT_MS,
  );
});

describe('forgot and reset password', () => {
  beforeEach(signedOut);

  it('should give the same answer whatever the email', async () => {
    server.use(http.post(api('auth/forgot-password'), () => ok(null)));
    renderApp('/forgot-password', 'ar');
    await ready('forgot-email');
    type('forgot-email', 'someone@example.test');
    click('forgot-submit');
    expect((await ready('forgot-sent')).textContent).toContain('تحقّق من بريدك الإلكتروني');
  });

  it('should take the token out of the address bar, check that the passwords match and send the user to sign in', async () => {
    let body: unknown;
    server.use(
      http.post(api('auth/reset-password'), async ({ request }) => {
        body = await request.json();
        return noContent();
      }),
    );
    const token = 'a'.repeat(43);
    const { router } = renderApp(`/reset-password?token=${token}`);
    await ready('reset-submit');
    await waitFor(() => expect(router.state.location.search).toBe(''));

    type('reset-new-password', 'Testtesttest1');
    type('reset-confirm-password', 'Testtesttest2');
    click('reset-submit');
    expect(await screen.findByText('The passwords do not match.')).toBeTruthy();

    type('reset-confirm-password', 'Testtesttest1');
    click('reset-submit');
    expect((await ready('login-notice')).textContent).toBe('Your password has been changed. Sign in with the new password.');
    expect(body).toEqual({ token, newPassword: 'Testtesttest1', confirmPassword: 'Testtesttest1' });
  });

  it('should sign out this tab and the others when the user resets while signed in', async () => {
    server.use(http.post(api('auth/reset-password'), noContent));
    const otherTabs = listenToOtherTabs();
    signedIn();
    renderApp(`/reset-password?token=${'e'.repeat(43)}`);
    await ready('reset-submit');
    type('reset-new-password', 'Testtesttest1');
    type('reset-confirm-password', 'Testtesttest1');
    click('reset-submit');
    expect(await ready('login-notice')).toBeTruthy();
    expect(useSession.getState()).toMatchObject({ status: 'anonymous', accessToken: null });
    await waitFor(() => expect(otherTabs.messages).toContainEqual({ type: 'signedOut', reason: 'signedOut' }));
    otherTabs.close();
  });

  it('should show the API password rules on the field, and other failures in a banner', async () => {
    server.use(http.post(api('auth/reset-password'), () => fail(400, 'VAL-001', [{ field: 'newPassword', message: 'validation.password.common' }])));
    renderApp(`/reset-password?token=${'f'.repeat(43)}`);
    await ready('reset-submit');
    type('reset-new-password', 'Testtesttest1');
    type('reset-confirm-password', 'Testtesttest1');
    click('reset-submit');
    expect(await screen.findByText('This password is too common. Choose another one.')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();

    server.use(http.post(api('auth/reset-password'), () => fail(500, 'SYS-001')));
    click('reset-submit');
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByTestId('reset-submit')).toBeTruthy();
  });

  it.each([
    ['a used or expired link (410 RES-004)', `/reset-password?token=${'b'.repeat(43)}`],
    ['no token at all', '/reset-password'],
  ])('should offer a new link for %s', async (_case, path) => {
    server.use(http.post(api('auth/reset-password'), () => fail(410, 'RES-004')));
    renderApp(path);
    if (path.includes('token')) {
      await ready('reset-submit');
      type('reset-new-password', 'Testtesttest1');
      type('reset-confirm-password', 'Testtesttest1');
      click('reset-submit');
    }
    expect(await ready('reset-invalid')).toBeTruthy();
    expect(screen.getByTestId('reset-request-new').getAttribute('href')).toBe('/forgot-password');
  });
});

describe('verify email', () => {
  it.each([
    ['signed in', true],
    ['signed out', false],
  ])('should confirm the email exactly once, %s, even in StrictMode', async (_case, isSignedIn) => {
    let calls = 0;
    server.use(
      http.post(api('auth/verify-email'), () => {
        calls += 1;
        return noContent();
      }),
    );
    if (isSignedIn) signedIn({ emailVerified: false });
    else signedOut();
    const { router } = renderApp(`/verify-email?token=${'c'.repeat(43)}`, 'en', { strict: true });
    expect(await ready('verify-success')).toBeTruthy();
    expect(screen.getByTestId('verify-continue').getAttribute('href')).toBe('/');
    expect(calls).toBe(1);
    expect(router.state.location.search).toBe('');
  });

  it('should let the user retry when the API could not be reached (the link is not lost)', async () => {
    signedOut();
    server.use(http.post(api('auth/verify-email'), () => fail(503, 'SYS-002')));
    renderApp(`/verify-email?token=${'g'.repeat(43)}`);
    expect(await ready('verify-error')).toBeTruthy();
    expect(screen.queryByTestId('verify-invalid')).toBeNull();

    server.use(http.post(api('auth/verify-email'), noContent));
    click('verify-retry');
    expect(await ready('verify-success')).toBeTruthy();
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
    expect(await ready('verify-invalid')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    type('verify-email', 'layla@example.test');
    click('verify-resend');
    expect(await ready('verify-resent')).toBeTruthy();
    expect(resent).toEqual({ email: 'layla@example.test' });
  });

  it.each(['ar', 'en'] as const)(
    'should be accessible in %s',
    async (locale) => {
      signedOut();
      renderApp('/verify-email', locale);
      await ready('verify-resend');
      await expectAccessible();
    },
    A11Y_TIMEOUT_MS,
  );
});

describe('sign out and lost sessions', () => {
  it('should sign out on the server, clear the session and every cached query, and tell the other tabs', async () => {
    let loggedOut = false;
    server.use(
      http.post(api('auth/logout'), () => {
        loggedOut = true;
        return noContent();
      }),
    );
    const otherTabs = listenToOtherTabs();
    signedIn();
    queryClient.setQueryData(['cases'], [{ id: 1 }]);
    const { router } = renderApp('/');
    await signOutFromMenu();
    expect(await ready('login-notice')).toBeTruthy();
    expect(loggedOut).toBe(true);
    expect(router.state.location.pathname).toBe('/login');
    expect(useSession.getState()).toMatchObject({ status: 'anonymous', user: null, accessToken: null });
    expect(queryClient.getQueryData(['cases'])).toBeUndefined();
    await waitFor(() => expect(otherTabs.messages).toContainEqual({ type: 'signedOut', reason: 'signedOut' }));
    otherTabs.close();
  });

  it('should still sign out locally (and tell the other tabs) when the server cannot be reached', async () => {
    server.use(http.post(api('auth/logout'), () => HttpResponse.error()));
    const otherTabs = listenToOtherTabs();
    signedIn();
    renderApp('/');
    await signOutFromMenu();
    expect(await ready('login-submit')).toBeTruthy();
    expect(useSession.getState().accessToken).toBeNull();
    await waitFor(() => expect(otherTabs.messages).toContainEqual({ type: 'signedOut', reason: 'signedOut' }));
    otherTabs.close();
  });

  it('should tell the other tabs about a sign-in', async () => {
    signedOut();
    server.use(http.post(api('auth/login'), () => ok(SESSION)));
    const otherTabs = listenToOtherTabs();
    renderApp('/login');
    await signIn();
    expect(await screen.findByTestId('page-dashboard')).toBeTruthy();
    await waitFor(() => expect(otherTabs.messages).toContainEqual({ type: 'signedIn' }));
    otherTabs.close();
  });

  it('should send the user to sign-in with a notice when a request finds the session gone (refresh refused)', async () => {
    server.use(
      http.get(api('things'), () => fail(401, 'AUTH-002')),
      http.post(api('auth/refresh'), () => fail(401, 'AUTH-005')),
    );
    signedIn();
    queryClient.setQueryData(['cases'], [{ id: 1 }]);
    const { router } = renderApp('/');
    await ready('page-dashboard');
    await expect(apiClient.request({ method: 'GET', path: 'things' })).rejects.toMatchObject({ code: 'AUTH-005' });
    expect((await ready('login-notice')).textContent).toBe('Your session has ended. Please sign in again.');
    expect(new URLSearchParams(router.state.location.search).get('reason')).toBe('expired');
    expect(queryClient.getQueryData(['cases'])).toBeUndefined();
  });

  it('should keep the user signed in when the refresh only failed for a temporary reason', async () => {
    server.use(
      http.get(api('things'), () => fail(401, 'AUTH-002')),
      http.post(api('auth/refresh'), () => fail(503, 'SYS-002')),
    );
    signedIn();
    renderApp('/');
    await ready('page-dashboard');
    await expect(apiClient.request({ method: 'GET', path: 'things' })).rejects.toMatchObject({ code: 'SYS-002' });
    expect(useSession.getState().status).toBe('authenticated');
    expect(screen.getByTestId('page-dashboard')).toBeTruthy();
  });

  it('should adopt the signed-in user language', async () => {
    signedIn({ uiLanguage: 'AR' });
    renderApp('/', 'en');
    expect((await ready('search-open')).getAttribute('aria-label')).toBe('بحث');
    expect(document.documentElement.dir).toBe('rtl');
    expect(document.documentElement.lang).toBe('ar');
  });

  it('should drop the previous user and their cached data when the cookie now belongs to someone else', async () => {
    signedIn();
    queryClient.setQueryData(['cases'], [{ id: 1 }]);
    const other = { ...SESSION, user: { ...USER, id: '01920000-0000-7000-8000-000000000009', fullName: 'Omar Saleh' } };
    server.use(http.post(api('auth/refresh'), () => ok(other)));
    await restoreSession();
    expect(useSession.getState().user?.fullName).toBe('Omar Saleh');
    expect(queryClient.getQueryData(['cases'])).toBeUndefined();
  });
});
