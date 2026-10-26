import type {
  OfficeProfile,
  OfficeSettings,
  OfficeSubscription,
} from '@nexlegtiq/shared-contracts';
import { permissionsFor } from '@nexlegtiq/shared-types';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';

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
import { useSession } from '../auth';

setupTestServer();

/** The first visit loads the page's chunk cold, which takes several seconds on a busy runner. */
const COLD = 20_000;
const SLOW = 60_000;
// axe over the whole settings page takes most of a minute when the full suite runs in parallel (as case-page.spec).
const AXE_SLOW = 180_000;

const subscription = (extra: Partial<OfficeSubscription> = {}): OfficeSubscription => ({
  plan: { code: 'PS_FREE', name: 'Free' },
  status: 'TRIALING',
  readOnly: false,
  periodEnd: '2027-04-17T00:00:00.000Z',
  trialEndsAt: '2027-04-17T00:00:00.000Z',
  limits: { users: 5, storageMb: 2048, aiMonthly: null },
  features: { ai: true, clientPortal: true, googleVisionOcr: false },
  usage: { users: 2, storageMb: 12, aiThisMonth: 3, aiResetsAt: '2026-10-31T22:00:00.000Z' },
  ...extra,
});

/** The visible text without the Unicode isolates that keep numbers and units in order (D-092). */
const plain = (element: Element) => (element.textContent ?? '').replace(/[⁦-⁩]/g, '');

const PROFILE: OfficeProfile = {
  id: '01920000-0000-7000-8000-0000000000e1',
  name: 'Haddad Law',
  registrationNumber: null,
  taxId: null,
  phone: null,
  email: null,
  address: null,
  website: null,
  jurisdiction: 'PALESTINE',
  accountType: 'FIRM',
  defaultLanguage: 'AR',
  currency: 'ILS',
  timezone: 'Asia/Hebron',
};
const SETTINGS: OfficeSettings = {
  courtReminderDays: [7, 3, 1],
  taskReminderDays: [1],
  defaultBillingRate: null,
  defaultBillingMethod: 'HOURLY',
  taxRatePercent: '0.00',
  enableAi: true,
  enableOcr: true,
  enableVisionOcr: false,
  fileNumberFormat: '{YEAR}-{TYPE}-{SEQ:5}',
  sessionIdleMinutes: 30,
  auditRetentionDays: 365,
};

beforeEach(() => {
  server.use(
    http.get(api('offices/me'), () => ok(PROFILE)),
    http.get(api('offices/me/settings'), () => ok(SETTINGS)),
  );
});

function serve(data: OfficeSubscription): void {
  server.use(http.get(api('offices/me/subscription'), () => ok(data)));
}

describe('Settings → Subscription (D-122)', () => {
  it(
    'should show the plan, status, usage against the limits and the features',
    async () => {
      setViewport(1280);
      signedIn();
      serve(subscription());
      renderApp('/settings');
      const section = await screen.findByTestId('subscription-section', {}, { timeout: COLD });
      await within(section).findByText('Free');
      expect(within(section).getByText('Trial')).toBeTruthy();
      expect(within(section).getByText('17 April 2027')).toBeTruthy();
      expect(plain(screen.getByTestId('usage-users'))).toContain('2 of 5');
      expect(plain(screen.getByTestId('usage-storage'))).toContain('12 MB of 2 GB');
      expect(plain(screen.getByTestId('usage-ai'))).toContain('3 (unlimited)');
      expect(screen.getByTestId('usage-users').querySelector('[aria-label]')).toBeTruthy();
      expect(screen.getByTestId('usage-ai').querySelector('.ant-progress')).toBeNull();
      // The AI count restarts at the office's next month (D-144): 31 Oct 22:00 UTC is 1 Nov in Hebron.
      expect(screen.getByTestId('usage-ai-resets').textContent).toContain('01/11/2026');
      expect(screen.getByTestId('feature-googleVisionOcr').textContent).toBe(
        'Enhanced OCR for difficult scans: Not included',
      );
      expect(screen.queryByTestId('read-only-banner')).toBeNull();
    },
    SLOW,
  );

  it(
    'should show the read-only banner in the shell and the reason in the section once the subscription ended',
    async () => {
      setViewport(1280);
      signedIn();
      serve(subscription({ status: 'EXPIRED', readOnly: true }));
      renderApp('/settings');
      expect(
        (await screen.findByTestId('read-only-banner', {}, { timeout: COLD })).textContent,
      ).toContain('read-only');
      const section = screen.getByTestId('subscription-section');
      await within(section).findByText('Expired');
      expect(within(section).getByRole('alert')).toBeTruthy();
    },
    SLOW,
  );

  it(
    'should show the read-only banner on every page to any role, in Arabic too, and pass axe',
    async () => {
      setViewport(1280);
      signedIn({ role: 'LAWYER', permissions: [...permissionsFor('LAWYER')], uiLanguage: 'AR' });
      serve(subscription({ status: 'EXPIRED', readOnly: true, limits: null, usage: null }));
      renderApp('/tasks', 'ar');
      const banner = await screen.findByTestId('read-only-banner', {}, { timeout: COLD });
      expect(banner.textContent).toContain('للقراءة فقط');
      const { violations } = await axe.run(document.body, {
        rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
      });
      expect(violations.map((violation) => violation.id)).toEqual([]);
    },
    SLOW,
  );

  it(
    'should hide the banner while the subscription is unknown',
    async () => {
      setViewport(1280);
      signedIn();
      server.use(http.get(api('offices/me/subscription'), () => fail(500, 'SYS-001')));
      renderApp('/tasks');
      await screen.findByTestId('page-tasks', {}, { timeout: COLD });
      await waitFor(() => expect(screen.queryByTestId('read-only-banner')).toBeNull());
    },
    SLOW,
  );

  it(
    'should offer a retry when the subscription cannot be loaded',
    async () => {
      setViewport(1280);
      signedIn();
      let calls = 0;
      server.use(
        http.get(api('offices/me/subscription'), () => {
          calls += 1;
          return calls <= 2 ? fail(500, 'SYS-001') : ok(subscription());
        }),
      );
      renderApp('/settings');
      const section = await screen.findByTestId('subscription-section', {}, { timeout: COLD });
      const retry = await within(section).findByRole('button', {}, { timeout: COLD });
      fireEvent.click(retry);
      await within(section).findByText('Free');
    },
    SLOW,
  );

  it(
    'should render in Arabic, right to left, and pass axe',
    async () => {
      setViewport(1280);
      signedIn({ uiLanguage: 'AR' });
      serve(subscription());
      renderApp('/settings', 'ar');
      const section = await screen.findByTestId('subscription-section', {}, { timeout: COLD });
      await within(section).findByText('فترة تجريبية');
      expect(document.documentElement.dir).toBe('rtl');
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('الإعدادات');
      expect(plain(screen.getByTestId('usage-users'))).toContain('2 من 5');
      const { violations } = await axe.run(document.body, {
        rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
      });
      expect(violations.map((violation) => violation.id)).toEqual([]);
    },
    AXE_SLOW,
  );
});

describe('Settings → office profile, preferences, defaults and security (D-125)', () => {
  async function openSettings(): Promise<void> {
    setViewport(1280);
    signedIn();
    serve(subscription());
    renderApp('/settings');
    await screen.findByTestId('settings-profile', {}, { timeout: COLD });
  }
  const input = (testId: string) => screen.getByTestId(testId) as HTMLInputElement;

  it(
    'should save only the changed profile fields and show the new name in the header',
    async () => {
      let body: unknown;
      server.use(
        http.patch(api('offices/me'), async ({ request }) => {
          body = await request.json();
          return ok({ ...PROFILE, name: 'Haddad & Partners', website: 'https://haddad.example' });
        }),
      );
      await openSettings();
      expect(input('settings-name').value).toBe('Haddad Law');
      fireEvent.change(input('settings-name'), { target: { value: 'Haddad & Partners' } });
      fireEvent.change(input('settings-website'), { target: { value: 'https://haddad.example' } });
      fireEvent.click(screen.getByTestId('settings-profile-save'));
      await waitFor(() =>
        expect(body).toEqual({ name: 'Haddad & Partners', website: 'https://haddad.example' }),
      );
      expect(await screen.findByText('Saved')).toBeTruthy();
      await waitFor(() => expect(useSession.getState().user?.officeName).toBe('Haddad & Partners'));
    },
    SLOW,
  );

  it(
    'should refuse an invalid case number format on the field, and show what the API refuses',
    async () => {
      let calls = 0;
      server.use(
        http.patch(api('offices/me/settings'), () => {
          calls += 1;
          return fail(400, 'VAL-001', [{ field: 'taxRatePercent', message: 'validation.percent' }]);
        }),
      );
      await openSettings();
      fireEvent.change(input('settings-file-number-format'), {
        target: { value: '{YEAR}-{TYPE}' },
      });
      fireEvent.click(screen.getByTestId('settings-defaults-save'));
      expect(await screen.findByText(/exactly one {SEQ}/)).toBeTruthy();
      expect(calls).toBe(0);

      fireEvent.change(input('settings-file-number-format'), { target: { value: 'F/{SEQ:3}' } });
      fireEvent.change(input('settings-tax-rate'), { target: { value: '16' } });
      fireEvent.click(screen.getByTestId('settings-defaults-save'));
      expect(await screen.findByText(/percentage from 0 to 100/)).toBeTruthy();
      expect(calls).toBe(1);
    },
    SLOW,
  );

  it(
    'should apply a new idle timeout to this tab at once',
    async () => {
      let body: unknown;
      server.use(
        http.patch(api('offices/me/settings'), async ({ request }) => {
          body = await request.json();
          return ok({ ...SETTINGS, sessionIdleMinutes: 60 });
        }),
      );
      await openSettings();
      fireEvent.change(input('settings-idle-minutes'), { target: { value: '60' } });
      fireEvent.click(screen.getByTestId('settings-security-save'));
      await waitFor(() => expect(body).toEqual({ sessionIdleMinutes: 60 }));
      await waitFor(() => expect(useSession.getState().idleMinutes).toBe(60));
    },
    SLOW,
  );

  it(
    'should ask before leaving with unsaved changes, and discard them on request',
    async () => {
      await openSettings();
      fireEvent.change(input('settings-phone'), { target: { value: '+970 59 123 4567' } });
      fireEvent.click(screen.getAllByRole('link', { name: /Tasks/ })[0] as HTMLElement);
      expect(await screen.findByText('Leave without saving?')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Stay on this page' }));
      await waitFor(() => expect(screen.queryByText('Leave without saving?')).toBeNull());
      expect(screen.getByTestId('page-settings')).toBeTruthy();

      fireEvent.click(screen.getByTestId('settings-profile-discard'));
      expect(input('settings-phone').value).toBe('');
      fireEvent.click(screen.getAllByRole('link', { name: /Tasks/ })[0] as HTMLElement);
      expect(await screen.findByTestId('page-tasks', {}, { timeout: COLD })).toBeTruthy();
    },
    SLOW,
  );
});
