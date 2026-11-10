import type { Locale } from '@nexlegtiq/shared-types';
import { LANGUAGE_STORAGE_KEY, NexProvider } from '@nexlegtiq/shared-ui';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { http, HttpResponse } from 'msw';
import type { JsonBodyType } from 'msw';
import { setupServer } from 'msw/node';
import { createMemoryRouter, RouterProvider } from 'react-router';

import { API_URL, queryClient, resetSession, restoreSession, useAdminSession } from './session';
import { routes } from '../../app/routes';

const api = (path: string) => `${API_URL}/api/v1/${path}`;
const meta = { timestamp: '2026-11-09T10:00:00.000Z', requestId: 'req-12345678' };
const ok = (data: JsonBodyType = null, status = 200) =>
  HttpResponse.json({ success: true, data, meta }, { status });
const fail = (status: number, code: string, details?: { field: string; message: string }[]) =>
  HttpResponse.json(
    { success: false, error: { code, message: `dev ${code}`, details }, meta },
    { status },
  );

const ADMIN = {
  id: '01920000-0000-7000-8000-000000000009',
  fullName: 'Founder Name',
  email: 'founder@example.test',
};
const SESSION = { accessToken: 'admin-access', expiresIn: 900, admin: ADMIN };
const CODES = Array.from({ length: 10 }, (_, i) => `ABCD${'EFGHIJKLMN'[i]}-QRSTU`);
const MINUTE = 60_000;

/** Polls with the real `setTimeout`: `waitFor` polls with `setInterval`, which the idle tests fake. */
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !condition(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(condition()).toBe(true);
}

const server = setupServer(
  http.post(api('admin/auth/refresh'), () => fail(401, 'AUTH-003')),
  // The signed-in home redirects to the offices list.
  http.get(api('admin/offices'), () =>
    HttpResponse.json({
      success: true,
      data: [],
      meta: {
        ...meta,
        pagination: { page: 1, limit: 20, total: 0, totalPages: 0, hasMore: false },
      },
    }),
  ),
);
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  resetSession();
  localStorage.clear();
  vi.useRealTimers();
});
afterAll(() => server.close());

const type = (testId: string, value: string) =>
  fireEvent.change(screen.getByTestId(testId), { target: { value } });
const click = (testId: string) => fireEvent.click(screen.getByTestId(testId));

async function renderApp(path = '/', locale: Locale = 'en') {
  localStorage.setItem(LANGUAGE_STORAGE_KEY, locale);
  await restoreSession();
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <QueryClientProvider client={queryClient}>
      <NexProvider>
        <RouterProvider router={router} />
      </NexProvider>
    </QueryClientProvider>,
  );
  return router;
}

async function fillCredentials() {
  await screen.findByTestId('login-email');
  type('login-email', 'founder@example.test');
  type('login-password', 'Testtesttest1');
}

async function expectAccessible(): Promise<void> {
  const { violations } = await axe.run(document.body, {
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
  });
  expect(violations.map((violation) => violation.id)).toEqual([]);
}

describe('admin sign-in', () => {
  it('should send an anonymous visitor to sign-in and sign in with the authenticator code', async () => {
    let body: unknown;
    server.use(
      http.post(api('admin/auth/login'), async ({ request }) => {
        body = await request.json();
        return ok(SESSION);
      }),
    );
    const router = await renderApp('/');
    await fillCredentials();
    type('login-code', '123456');
    click('login-submit');

    expect(await screen.findByTestId('admin-name')).toHaveProperty('textContent', 'Founder Name');
    await waitFor(() => expect(router.state.location.pathname).toBe('/offices'));
    expect(body).toEqual({
      email: 'founder@example.test',
      password: 'Testtesttest1',
      code: '123456',
    });
    expect(useAdminSession.getState().accessToken).toBe('admin-access');
  });

  it('should sign in with a recovery code instead of the app code', async () => {
    let body: unknown;
    server.use(
      http.post(api('admin/auth/login'), async ({ request }) => {
        body = await request.json();
        return ok(SESSION);
      }),
    );
    await renderApp('/login');
    await fillCredentials();
    click('login-toggle-recovery');
    type('login-recovery-code', 'ABCDE-FGHIJ');
    click('login-submit');

    await screen.findByTestId('home-page');
    expect(body).toEqual({
      email: 'founder@example.test',
      password: 'Testtesttest1',
      recoveryCode: 'ABCDE-FGHIJ',
    });
  });

  it('should explain a wrong code (AUTH-009)', async () => {
    server.use(http.post(api('admin/auth/login'), () => fail(401, 'AUTH-009')));
    await renderApp('/login');
    await fillCredentials();
    type('login-code', '000000');
    click('login-submit');

    expect((await screen.findByTestId('login-error')).textContent).toContain(
      'The verification code is incorrect.',
    );
    expect(useAdminSession.getState().status).toBe('anonymous');
  });

  it('should restore a live session at start and skip sign-in', async () => {
    server.use(http.post(api('admin/auth/refresh'), () => ok(SESSION)));
    await renderApp('/login');
    expect(await screen.findByTestId('home-page')).toBeTruthy();
  });

  it('should be accessible in Arabic (RTL) and English', { timeout: 60_000 }, async () => {
    await renderApp('/login', 'ar');
    await screen.findByTestId('login-email');
    expect(document.documentElement.dir).toBe('rtl');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('دخول الإدارة');
    await expectAccessible();
    cleanup();
    await renderApp('/login', 'en');
    await screen.findByTestId('login-email');
    expect(document.documentElement.dir).toBe('ltr');
    await expectAccessible();
  });
});

describe('authenticator enrolment', () => {
  function enrolmentServer() {
    const calls = { enroll: 0, confirm: undefined as unknown };
    server.use(
      http.post(api('admin/auth/login'), () =>
        fail(401, 'AUTH-008', [{ field: 'code', message: 'validation.mfaEnrollment' }]),
      ),
      http.post(api('admin/auth/enroll'), () => {
        calls.enroll += 1;
        return ok({
          otpauthUri: 'otpauth://totp/NexLegTiq:founder?secret=JBSWY3DPEHPK3PXP',
          secret: 'JBSWY3DPEHPK3PXP',
        });
      }),
      http.post(api('admin/auth/enroll/confirm'), async ({ request }) => {
        calls.confirm = await request.json();
        return ok({ ...SESSION, recoveryCodes: CODES }, 201);
      }),
    );
    return calls;
  }

  it('should enrol a new admin and show the recovery codes once', { timeout: 60_000 }, async () => {
    const calls = enrolmentServer();
    const router = await renderApp('/login');
    await fillCredentials();
    click('login-submit');

    expect((await screen.findByTestId('enroll-secret')).textContent).toContain('JBSWY3DPEHPK3PXP');
    expect(screen.getByTestId('enroll-qr')).toBeTruthy();
    expect(router.state.location.state).toBeNull(); // the password never sits in history.state
    await expectAccessible();
    type('enroll-code', '123456');
    click('enroll-submit');

    const list = await screen.findByTestId('recovery-codes');
    expect(list.querySelectorAll('li')).toHaveLength(10);
    expect(calls.confirm).toEqual({
      email: 'founder@example.test',
      password: 'Testtesttest1',
      code: '123456',
    });
    expect(calls.enroll).toBe(1);
    // The password is dropped as soon as the authenticator is confirmed.
    expect(useAdminSession.getState().pendingEnrollment).toBeNull();
    expect(screen.getByTestId('recovery-continue')).toHaveProperty('disabled', true);

    click('recovery-saved');
    click('recovery-continue');
    await screen.findByTestId('home-page');
    expect(screen.queryByTestId('recovery-codes')).toBeNull();
    expect(useAdminSession.getState().status).toBe('authenticated');
  });

  it('should send /enroll without the sign-in credentials back to sign-in', async () => {
    const router = await renderApp('/enroll');
    await screen.findByTestId('login-email');
    expect(router.state.location.pathname).toBe('/login');
  });

  it('should show why the secret could not be issued (enrolment window passed)', async () => {
    enrolmentServer();
    server.use(http.post(api('admin/auth/enroll'), () => fail(410, 'RES-004')));
    await renderApp('/login');
    await fillCredentials();
    click('login-submit');
    expect(await screen.findByTestId('enroll-error')).toBeTruthy();
    click('enroll-back');
    await screen.findByTestId('login-email');
  });
});

describe('idle timeout', () => {
  it('should warn during the last minute and sign out after 30 minutes', async () => {
    let loggedOut = false;
    server.use(
      http.post(api('admin/auth/refresh'), () => ok(SESSION)),
      http.post(api('admin/auth/logout'), () => {
        loggedOut = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    // Only the clock and the interval are faked: MSW and promises keep real timers.
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    const router = await renderApp('/');
    await screen.findByTestId('home-page');

    act(() => void vi.advanceTimersByTime(29 * MINUTE + 1000));
    expect(await screen.findByTestId('idle-countdown')).toBeTruthy();
    act(() => void vi.advanceTimersByTime(MINUTE));

    await waitFor(() => expect(router.state.location.search).toBe('?reason=idle'));
    expect(loggedOut).toBe(true);
    expect(screen.getByTestId('login-notice').textContent).toContain('inactivity');
  });
});

describe('review cases', () => {
  it('should ask for the code on a plain AUTH-008 instead of enrolling', async () => {
    server.use(http.post(api('admin/auth/login'), () => fail(401, 'AUTH-008')));
    const router = await renderApp('/login');
    await fillCredentials();
    click('login-submit');
    expect((await screen.findByTestId('login-error')).textContent).toContain(
      'Enter your verification code to continue.',
    );
    expect(router.state.location.pathname).toBe('/login');
  });

  it('should drop the pending password when enrolment is abandoned', async () => {
    server.use(
      http.post(api('admin/auth/login'), () =>
        fail(401, 'AUTH-008', [{ field: 'code', message: 'validation.mfaEnrollment' }]),
      ),
      http.post(api('admin/auth/enroll'), () => fail(410, 'RES-004')),
    );
    await renderApp('/login');
    await fillCredentials();
    click('login-submit');
    await screen.findByTestId('enroll-back');
    expect(useAdminSession.getState().pendingEnrollment).not.toBeNull();
    click('enroll-back');
    await screen.findByTestId('login-email');
    expect(useAdminSession.getState().pendingEnrollment).toBeNull();
  });

  it('should show why the start-up restore failed, not "unreachable"', async () => {
    server.use(http.post(api('admin/auth/refresh'), () => fail(403, 'AUTH-100')));
    await renderApp('/');
    expect((await screen.findByRole('alert')).textContent).toContain('req-12345678');
    expect(useAdminSession.getState().startupError?.code).toBe('AUTH-100');
  });

  it('should keep an active session alive and stay signed in from the warning', async () => {
    let refreshes = 0;
    server.use(
      http.post(api('admin/auth/refresh'), () => {
        refreshes += 1;
        return ok(SESSION);
      }),
    );
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    await renderApp('/');
    await screen.findByTestId('home-page');
    expect(refreshes).toBe(1);

    // Working (activity) for 11 minutes without a single request: the timer refreshes the server session once.
    act(() => void vi.advanceTimersByTime(5 * MINUTE));
    fireEvent.keyDown(window);
    act(() => void vi.advanceTimersByTime(6 * MINUTE));
    await until(() => refreshes === 2);

    // Idle until the warning, then "stay signed in".
    act(() => void vi.advanceTimersByTime(29 * MINUTE + 1000));
    await screen.findByTestId('idle-stay');
    click('idle-stay');
    act(() => void vi.advanceTimersByTime(2 * MINUTE));
    expect(useAdminSession.getState().status).toBe('authenticated');
  });
});
