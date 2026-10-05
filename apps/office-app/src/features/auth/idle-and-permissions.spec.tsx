import { permissionsFor } from '@nexlegtiq/shared-types';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { HttpResponse } from 'msw';

import { AppRoot } from '../../app/app-root';
import { api, http, server, SESSION, setupTestServer, signedIn } from '../../test/render-app';
import { IdleTimeout } from './components/IdleTimeout';
import { RequirePermission } from './components/guards';
import { useSession } from './session';

setupTestServer();

const MINUTE = 60_000;

/** Polls with the real `setTimeout` (only the clock and intervals are faked). */
async function until(check: () => void): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      check();
      return;
    } catch (error) {
      if (attempt > 100) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

function renderIdle(): { logouts: () => number } {
  let logouts = 0;
  server.use(
    http.post(api('auth/logout'), () => {
      logouts += 1;
      return new Response(null, { status: 204 });
    }),
  );
  signedIn();
  render(
    <AppRoot>
      <IdleTimeout />
    </AppRoot>,
  );
  return { logouts: () => logouts };
}

describe('IdleTimeout', () => {
  beforeEach(() => {
    // Only the clock and the interval are faked: MSW and promises keep real timers.
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  });

  it('should warn during the last minute, then sign out after 30 minutes without activity', async () => {
    const { logouts } = renderIdle();
    act(() => vi.advanceTimersByTime(28 * MINUTE));
    expect(screen.queryByTestId('idle-countdown')).toBeNull();

    act(() => vi.advanceTimersByTime(MINUTE + 1000));
    expect((await screen.findByTestId('idle-countdown')).textContent).toContain('59 seconds');

    act(() => vi.advanceTimersByTime(MINUTE));
    await until(() => expect(useSession.getState()).toMatchObject({ status: 'anonymous', signOutReason: 'idle' }));
    expect(logouts()).toBe(1);
  });

  it('should start counting again when the user stays signed in or does anything', async () => {
    renderIdle();
    act(() => vi.advanceTimersByTime(29 * MINUTE + 30_000));
    fireEvent.click(await screen.findByTestId('idle-stay'));
    act(() => vi.advanceTimersByTime(28 * MINUTE));
    fireEvent.keyDown(window, { key: 'a' });
    act(() => vi.advanceTimersByTime(28 * MINUTE));
    expect(useSession.getState().status).toBe('authenticated');
  });

  it('should count activity in another tab of this browser', async () => {
    renderIdle();
    const otherTab = new BroadcastChannel('nlq-session');
    act(() => vi.advanceTimersByTime(29 * MINUTE));
    otherTab.postMessage({ type: 'activity', at: Date.now() });
    await new Promise((resolve) => setTimeout(resolve, 20));
    act(() => vi.advanceTimersByTime(2 * MINUTE));
    expect(useSession.getState().status).toBe('authenticated');
    otherTab.close();
  });

  it('should follow the office setting', async () => {
    renderIdle();
    act(() => useSession.setState({ idleMinutes: 15 }));
    act(() => vi.advanceTimersByTime(15 * MINUTE + 1000));
    await until(() => expect(useSession.getState().signOutReason).toBe('idle'));
  });

  it('should sign out at once from the warning', async () => {
    renderIdle();
    act(() => vi.advanceTimersByTime(29 * MINUTE + 1000));
    fireEvent.click(await screen.findByTestId('idle-sign-out'));
    await until(() => expect(useSession.getState()).toMatchObject({ status: 'anonymous', signOutReason: 'signedOut' }));
  });
});

describe('other tabs', () => {
  it('should follow a sign-out and a sign-in in another tab of this browser', async () => {
    const otherTab = new BroadcastChannel('nlq-session');
    signedIn();
    otherTab.postMessage({ type: 'signedOut' });
    await until(() => expect(useSession.getState()).toMatchObject({ status: 'anonymous', signOutReason: 'signedOut', accessToken: null }));

    server.use(http.post(api('auth/refresh'), () => HttpResponse.json({ success: true, data: SESSION, meta: { timestamp: '', requestId: 'req-12345678' } })));
    otherTab.postMessage({ type: 'signedIn' });
    await until(() => expect(useSession.getState()).toMatchObject({ status: 'authenticated', accessToken: 'access-1' }));
    otherTab.close();
  });
});

describe('RequirePermission', () => {
  it.each([
    ['TRAINEE', false],
    ['OFFICE_MANAGER', true],
  ] as const)('should show a %s the page only with the permission (%s)', (role, allowed) => {
    signedIn({ role, permissions: [...permissionsFor(role)] });
    render(
      <AppRoot>
        <RequirePermission perform="manage:users">
          <p>team page</p>
        </RequirePermission>
      </AppRoot>,
    );
    expect(screen.queryByText('team page') !== null).toBe(allowed);
    if (!allowed) expect(screen.getByRole('alert').textContent).not.toBe('');
  });
});
