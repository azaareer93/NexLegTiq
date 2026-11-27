import type { OfficeSubscription } from '@nexlegtiq/shared-contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

import {
  api,
  fail,
  http,
  ok,
  renderApp,
  server,
  setupTestServer,
  setViewport,
  signedIn,
} from '../../test/render-app';

setupTestServer();

const COLD = 20_000;
const SLOW = 60_000;
const SCHEDULED = '2026-12-27T10:00:00.000Z';

const subscription = (deletionScheduledFor: string | null): OfficeSubscription => ({
  plan: { code: 'PS_FREE', name: 'Free' },
  status: 'ACTIVE',
  readOnly: deletionScheduledFor !== null,
  deletionScheduledFor,
  periodEnd: null,
  trialEndsAt: null,
  limits: null,
  features: { ai: true, clientPortal: true, googleVisionOcr: false },
  usage: null,
});

/** The settings page with its office calls answered; `scheduled` is the deletion state the server starts with. */
function serve(scheduled: string | null): { bodies: unknown[]; cancels: () => number } {
  const bodies: unknown[] = [];
  let cancels = 0;
  let state = scheduled;
  server.use(
    http.get(api('offices/me/subscription'), () => ok(subscription(state))),
    http.get(api('offices/me/delete-request'), () =>
      ok({ requestedAt: state ? '2026-11-27T10:00:00.000Z' : null, scheduledFor: state }),
    ),
    http.post(api('offices/me/delete-request'), async ({ request }) => {
      const body = (await request.json()) as { password: string; mfaCode?: string };
      bodies.push(body);
      if (body.password !== 'right') {
        return fail(400, 'VAL-001', [
          { field: 'password', message: 'validation.password.currentWrong' },
        ]);
      }
      if (!body.mfaCode) {
        return fail(400, 'VAL-001', [{ field: 'mfaCode', message: 'validation.required' }]);
      }
      state = SCHEDULED;
      return ok({ requestedAt: '2026-11-27T10:00:00.000Z', scheduledFor: state });
    }),
    http.post(api('offices/me/delete-request/cancel'), () => {
      cancels += 1;
      state = null;
      return ok({ requestedAt: null, scheduledFor: null });
    }),
  );
  return { bodies, cancels: () => cancels };
}

describe('Settings → Delete the office (MVP-152, D-251)', () => {
  it(
    'should explain what happens, ask for the password (and the code when MFA is on), then show the date',
    async () => {
      setViewport(1280);
      signedIn();
      const { bodies } = serve(null);
      renderApp('/settings');
      const section = await screen.findByTestId('settings-deletion', {}, { timeout: COLD });
      expect(within(section).getByTestId('deletion-consequences').textContent).toContain(
        'invoices as issued',
      );
      fireEvent.click(within(section).getByTestId('deletion-request'));
      fireEvent.change(await screen.findByTestId('deletion-password'), {
        target: { value: 'wrong' },
      });
      fireEvent.click(screen.getByTestId('deletion-confirm'));
      expect(await screen.findByText('The current password is incorrect.')).toBeTruthy();
      expect(screen.queryByTestId('deletion-code')).toBeNull();

      fireEvent.change(screen.getByTestId('deletion-password'), { target: { value: 'right' } });
      fireEvent.click(screen.getByTestId('deletion-confirm'));
      // The code field appears with the server's error already on it, not empty.
      const code = await screen.findByTestId('deletion-code');
      expect(await screen.findByText('This field is required.')).toBeTruthy();
      expect(screen.getByTestId('deletion-dismiss').textContent).toBe('Close');
      fireEvent.change(code, { target: { value: '123456' } });
      fireEvent.click(screen.getByTestId('deletion-confirm'));
      await screen.findByTestId('deletion-scheduled', {}, { timeout: COLD });
      expect(bodies.at(-1)).toEqual({ password: 'right', mfaCode: '123456' });
      // The shell turns read-only and says why.
      await waitFor(() =>
        expect(screen.getByTestId('read-only-banner').textContent).toContain(
          'scheduled for deletion',
        ),
      );
    },
    SLOW,
  );

  it(
    'should cancel a scheduled deletion, in Arabic too',
    async () => {
      setViewport(1280);
      signedIn({ uiLanguage: 'AR' });
      const { cancels } = serve(SCHEDULED);
      renderApp('/settings', 'ar');
      const section = await screen.findByTestId('settings-deletion', {}, { timeout: COLD });
      expect(document.documentElement.dir).toBe('rtl');
      expect(within(section).getByTestId('deletion-scheduled').textContent).toContain(
        'سيُحذف هذا المكتب',
      );
      fireEvent.click(within(section).getByTestId('deletion-cancel'));
      await waitFor(() => expect(cancels()).toBe(1));
      await within(section).findByTestId('deletion-request');
    },
    SLOW,
  );
});
