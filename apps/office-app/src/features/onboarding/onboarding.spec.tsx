import type { OfficeProfile, OnboardingState } from '@nexlegtiq/shared-contracts';
import { permissionsFor } from '@nexlegtiq/shared-types';
import type { AccountType } from '@nexlegtiq/shared-types';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';

import { advance, stepsFor } from './api/use-onboarding';
import {
  api,
  EMPTY_DASHBOARD,
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

const profile = (accountType: AccountType): OfficeProfile => ({
  id: '01920000-0000-7000-8000-0000000000e1',
  name: 'Haddad Law',
  registrationNumber: null,
  taxId: null,
  phone: null,
  email: null,
  address: null,
  website: null,
  jurisdiction: 'PALESTINE',
  accountType,
  defaultLanguage: 'AR',
  currency: 'ILS',
  timezone: 'Asia/Hebron',
});

function serve(state: OnboardingState | null, accountType: AccountType = 'CORPORATE') {
  const saved: OnboardingState[] = [];
  const patched: unknown[] = [];
  let current = state;
  server.use(
    http.get(api('offices/me'), () => ok(profile(accountType))),
    http.patch(api('offices/me'), async ({ request }) => {
      patched.push(await request.json());
      return ok(profile(accountType));
    }),
    http.get(api('users/me/onboarding'), () => ok({ state: current })),
    http.put(api('users/me/onboarding'), async ({ request }) => {
      current = (await request.json()) as OnboardingState;
      saved.push(current);
      return ok({ state: current });
    }),
    http.get(api('dashboard'), () => ok(EMPTY_DASHBOARD)),
  );
  return { saved, patched };
}

function open(path: string, locale: 'en' | 'ar' = 'en') {
  setViewport(1280);
  signedIn({
    role: 'OFFICE_MANAGER',
    uiLanguage: locale === 'ar' ? 'AR' : 'EN',
    permissions: [...permissionsFor('OFFICE_MANAGER')],
  });
  renderApp(path, locale);
}

describe('onboarding steps (D-181)', () => {
  it('should leave out the invite for a solo practice and put it first for a firm', () => {
    expect(stepsFor('SOLO')).not.toContain('INVITE');
    expect(stepsFor('FIRM').slice(0, 3)).toEqual(['ACCOUNT', 'INVITE', 'OFFICE']);
    expect(stepsFor('CORPORATE')).toHaveLength(8);
  });

  it('should mark a step done on Next only, once', () => {
    const state: OnboardingState = { status: 'ACTIVE', step: 'OFFICE', done: ['ACCOUNT'] };
    expect(advance(state, 'OFFICE', 'INVITE', true).done).toEqual(['ACCOUNT', 'OFFICE']);
    expect(advance(state, 'OFFICE', 'INVITE', false).done).toEqual(['ACCOUNT']);
    expect(advance(state, 'ACCOUNT', 'OFFICE', true).done).toEqual(['ACCOUNT']);
  });
});

describe('onboarding wizard (MVP-108)', () => {
  it(
    'should resume at the saved step, save the office setup, and move on with Next',
    { timeout: SLOW },
    async () => {
      const calls = serve({ status: 'ACTIVE', step: 'OFFICE', done: ['ACCOUNT'] });
      open('/onboarding');
      expect(
        (await screen.findByTestId('onboarding-progress', {}, { timeout: COLD })).textContent,
      ).toBe('Step 2 of 8');
      expect(screen.getByTestId('onboarding-step-title').textContent).toBe('Office setup');
      fireEvent.click(await screen.findByTestId('onboarding-office-save'));
      await waitFor(() => expect(calls.patched).toHaveLength(1));
      expect(calls.patched[0]).toMatchObject({ jurisdiction: 'PALESTINE', currency: 'ILS' });
      fireEvent.click(screen.getByTestId('onboarding-next'));
      await waitFor(() =>
        expect(calls.saved.at(-1)).toEqual({
          status: 'ACTIVE',
          step: 'INVITE',
          done: ['ACCOUNT', 'OFFICE'],
        }),
      );
      expect((await screen.findByTestId('onboarding-progress')).textContent).toBe('Step 3 of 8');
    },
  );

  it(
    'should skip without marking done, and be one step shorter for a solo practice',
    { timeout: SLOW },
    async () => {
      const calls = serve({ status: 'ACTIVE', step: 'OFFICE', done: ['ACCOUNT'] }, 'SOLO');
      open('/onboarding');
      expect(
        (await screen.findByTestId('onboarding-progress', {}, { timeout: COLD })).textContent,
      ).toBe('Step 2 of 7');
      fireEvent.click(screen.getByTestId('onboarding-skip'));
      await waitFor(() =>
        expect(calls.saved.at(-1)).toEqual({ status: 'ACTIVE', step: 'TOUR', done: ['ACCOUNT'] }),
      );
    },
  );

  it(
    'should start a wizard never offered, and dismiss it for good',
    { timeout: SLOW },
    async () => {
      const calls = serve(null);
      open('/onboarding');
      await waitFor(() =>
        expect(calls.saved[0]).toEqual({ status: 'ACTIVE', step: 'ACCOUNT', done: [] }),
      );
      expect(
        (await screen.findByTestId('onboarding-progress', {}, { timeout: COLD })).textContent,
      ).toBe('Step 1 of 8');
      fireEvent.click(screen.getByTestId('onboarding-dismiss'));
      await waitFor(() => expect(calls.saved.at(-1)?.status).toBe('DISMISSED'));
      expect(await screen.findByTestId('page-dashboard', {}, { timeout: COLD })).toBeTruthy();
      expect(screen.queryByTestId('onboarding-nudge')).toBeNull();
    },
  );

  it(
    'should finish on the checklist and nudge on the dashboard while unfinished',
    { timeout: SLOW },
    async () => {
      const calls = serve({ status: 'ACTIVE', step: 'DONE', done: ['ACCOUNT', 'OFFICE', 'CASE'] });
      open('/onboarding');
      const list = await screen.findByTestId('onboarding-checklist', {}, { timeout: COLD });
      expect(list.textContent).toContain('Office setup');
      expect(list.textContent).toContain('Skipped');
      fireEvent.click(screen.getByTestId('onboarding-next'));
      await waitFor(() => expect(calls.saved.at(-1)?.status).toBe('COMPLETED'));
      expect(await screen.findByTestId('page-dashboard', {}, { timeout: COLD })).toBeTruthy();
    },
  );

  it(
    'should show the nudge on the dashboard for an unfinished setup',
    { timeout: SLOW },
    async () => {
      serve({ status: 'ACTIVE', step: 'TOUR', done: ['ACCOUNT'] });
      open('/');
      expect(await screen.findByTestId('onboarding-nudge', {}, { timeout: COLD })).toBeTruthy();
    },
  );

  it('should be accessible in Arabic', { timeout: SLOW }, async () => {
    serve({ status: 'ACTIVE', step: 'TOUR', done: ['ACCOUNT'] });
    open('/onboarding', 'ar');
    expect(
      (await screen.findByTestId('onboarding-progress', {}, { timeout: COLD })).textContent,
    ).toBe('الخطوة 4 من 8');
    expect(document.documentElement.dir).toBe('rtl');
    const { violations } = await axe.run(document.body, {
      rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
    });
    expect(violations.map((v) => v.id)).toEqual([]);
  });
});
