import type { OfficeSubscription } from '@nexlegtiq/shared-contracts';
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

setupTestServer();

/** The first visit loads the page's chunk cold, which takes several seconds on a busy runner. */
const COLD = 20_000;
const SLOW = 60_000;

const subscription = (extra: Partial<OfficeSubscription> = {}): OfficeSubscription => ({
  plan: { code: 'PS_FREE', name: 'Free' },
  status: 'TRIALING',
  readOnly: false,
  periodEnd: '2027-04-17T00:00:00.000Z',
  trialEndsAt: '2027-04-17T00:00:00.000Z',
  limits: { users: 5, storageMb: 2048, aiMonthly: null },
  features: { ai: true, clientPortal: true, googleVisionOcr: false },
  usage: { users: 2, storageMb: 12, aiThisMonth: 3 },
  ...extra,
});

/** The visible text without the Unicode isolates that keep numbers and units in order (D-092). */
const plain = (element: Element) => (element.textContent ?? '').replace(/[⁦-⁩]/g, '');

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
    SLOW,
  );
});
