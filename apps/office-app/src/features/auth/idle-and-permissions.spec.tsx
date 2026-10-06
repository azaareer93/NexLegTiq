import { LANGUAGE_STORAGE_KEY } from '@nexlegtiq/shared-ui';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { HttpResponse } from 'msw';

import { AppRoot } from '../../app/app-root';
import {
  api,
  http,
  ok,
  server,
  SESSION,
  setupTestServer,
  signedIn,
  USER,
} from '../../test/render-app';
import { IdleTimeout } from './components/IdleTimeout';
import { queryClient, useSession } from './session';

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

/** Lets a sign-out that may have started (an HTTP call on real timers) finish before asserting it did not happen. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

function renderIdle(uiLanguage: 'AR' | 'EN' = 'EN'): { logouts: () => number } {
  let logouts = 0;
  server.use(
    http.post(api('auth/logout'), () => {
      logouts += 1;
      return new HttpResponse(null, { status: 204 });
    }),
  );
  signedIn({ uiLanguage });
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
    expect((await screen.findByTestId('idle-countdown')).textContent).toBe(
      'For your security, you will be signed out in 59 seconds.',
    );

    act(() => vi.advanceTimersByTime(MINUTE));
    await until(() =>
      expect(useSession.getState()).toMatchObject({ status: 'anonymous', signOutReason: 'idle' }),
    );
    expect(logouts()).toBe(1);
  });

  it.each([
    [1, 'خلال ثانية واحدة'],
    [2, 'خلال ثانيتين'],
    [5, 'خلال 5 ثوانٍ'],
    [11, 'خلال 11 ثانية'],
  ])('should count down in Arabic with the right plural form (%i)', async (seconds, text) => {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, 'ar');
    renderIdle('AR');
    act(() => vi.advanceTimersByTime(30 * MINUTE - seconds * 1000));
    expect((await screen.findByTestId('idle-countdown')).textContent).toContain(text);
    expect(document.documentElement.dir).toBe('rtl');
  });

  it('should start counting again when the user stays signed in or does anything', async () => {
    const { logouts } = renderIdle();
    act(() => vi.advanceTimersByTime(29 * MINUTE + 30_000));
    fireEvent.click(await screen.findByTestId('idle-stay'));
    act(() => vi.advanceTimersByTime(28 * MINUTE));
    fireEvent.keyDown(window, { key: 'a' });
    act(() => vi.advanceTimersByTime(28 * MINUTE));
    await settle();
    expect(useSession.getState().status).toBe('authenticated');
    expect(logouts()).toBe(0);
  });

  it('should keep the warning open while the pointer moves towards its buttons', async () => {
    renderIdle();
    act(() => vi.advanceTimersByTime(29 * MINUTE + 10_000));
    await screen.findByTestId('idle-countdown');
    fireEvent.mouseMove(window);
    act(() => vi.advanceTimersByTime(2000));
    expect(screen.getByTestId('idle-countdown').textContent).toContain('seconds');
  });

  it('should count activity in another tab of this browser, and ignore nonsense timestamps', async () => {
    const { logouts } = renderIdle();
    const otherTab = new BroadcastChannel('nlq-session');
    act(() => vi.advanceTimersByTime(29 * MINUTE));
    otherTab.postMessage({ type: 'activity', at: Date.now() });
    await settle();
    act(() => vi.advanceTimersByTime(2 * MINUTE));
    await settle();
    expect(useSession.getState().status).toBe('authenticated');
    expect(logouts()).toBe(0);

    // A timestamp in the future, or not a number, must not keep the session alive.
    otherTab.postMessage({ type: 'activity', at: Date.now() + 365 * 24 * 60 * MINUTE });
    otherTab.postMessage({ type: 'activity', at: 'later' });
    await settle();
    act(() => vi.advanceTimersByTime(30 * MINUTE));
    await until(() => expect(useSession.getState().signOutReason).toBe('idle'));
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
    await until(() =>
      expect(useSession.getState()).toMatchObject({
        status: 'anonymous',
        signOutReason: 'signedOut',
      }),
    );
  });
});

describe('other tabs', () => {
  it('should follow a sign-out in another tab, with its reason', async () => {
    const otherTab = new BroadcastChannel('nlq-session');
    signedIn();
    otherTab.postMessage({ type: 'signedOut', reason: 'idle' });
    await until(() =>
      expect(useSession.getState()).toMatchObject({
        status: 'anonymous',
        signOutReason: 'idle',
        accessToken: null,
      }),
    );
    otherTab.close();
  });

  it('should restore its own session when another tab signs in, and switch users with a clean cache', async () => {
    const otherTab = new BroadcastChannel('nlq-session');
    signedIn();
    queryClient.setQueryData(['cases'], [{ id: 1 }]);
    const other = { ...SESSION, user: { ...USER, id: '01920000-0000-7000-8000-000000000009' } };
    server.use(http.post(api('auth/refresh'), () => ok(other)));
    otherTab.postMessage({ type: 'signedIn' });
    await until(() => expect(useSession.getState().user?.id).toBe(other.user.id));
    expect(queryClient.getQueryData(['cases'])).toBeUndefined();
    otherTab.close();
  });

  it('should ignore messages it does not understand', async () => {
    const otherTab = new BroadcastChannel('nlq-session');
    signedIn();
    otherTab.postMessage({ type: 'promote', role: 'OFFICE_MANAGER' });
    otherTab.postMessage('signedOut');
    await settle();
    expect(useSession.getState().status).toBe('authenticated');
    otherTab.close();
  });
});
