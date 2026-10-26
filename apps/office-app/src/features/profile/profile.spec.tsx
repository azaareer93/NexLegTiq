import type { NotificationPreferences, Profile } from '@nexlegtiq/shared-contracts';
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
  USER,
} from '../../test/render-app';
import { useSession } from '../auth';

setupTestServer();

const COLD = 20_000;
const SLOW = 60_000;

const PROFILE: Profile = {
  id: USER.id,
  fullName: USER.fullName,
  email: USER.email,
  role: USER.role,
  phone: null,
  uiLanguage: 'EN',
  timezone: null,
  digitStyle: 'WESTERN',
  avatar: null,
};
const PREFS: NotificationPreferences = [
  { category: 'TASKS', inApp: true, email: null },
  { category: 'HEARINGS', inApp: true, email: true },
];

function serve(profile: Profile = PROFILE): { patches: unknown[] } {
  const patches: unknown[] = [];
  server.use(
    http.get(api('users/me'), () => ok(profile)),
    http.patch(api('users/me'), async ({ request }) => {
      const body = (await request.json()) as Partial<Profile>;
      patches.push(body);
      return ok({ ...profile, ...body });
    }),
    http.get(api('notifications/preferences'), () => ok(PREFS)),
    http.patch(api('notifications/preferences'), async ({ request }) => {
      patches.push({ prefs: await request.json() });
      return ok([PREFS[0], { ...PREFS[1], email: false }]);
    }),
  );
  return { patches };
}

async function openProfile(locale: 'en' | 'ar' = 'en'): Promise<void> {
  setViewport(1280);
  signedIn(locale === 'ar' ? { uiLanguage: 'AR' } : {});
  renderApp('/profile', locale);
  await screen.findByTestId('profile-personal', {}, { timeout: COLD });
}

describe('Profile page (D-146)', () => {
  it(
    'should save only the changed name and show it in the header at once',
    async () => {
      const { patches } = serve();
      await openProfile();
      expect(screen.getByTestId('profile-email').textContent).toBe(USER.email);
      fireEvent.change(screen.getByTestId('profile-full-name'), {
        target: { value: 'Layla Haddad-Nasser' },
      });
      fireEvent.click(screen.getByTestId('profile-personal-save'));
      await waitFor(() => expect(patches).toEqual([{ fullName: 'Layla Haddad-Nasser' }]));
      await waitFor(() => expect(useSession.getState().user?.fullName).toBe('Layla Haddad-Nasser'));
    },
    SLOW,
  );

  it(
    'should switch the app to Arabic-Indic digits once saved',
    async () => {
      const { patches } = serve();
      await openProfile();
      const digits = within(screen.getByTestId('profile-display')).getByTestId('profile-digits');
      fireEvent.mouseDown(digits.querySelector('input') ?? digits);
      fireEvent.click(await screen.findByText('Arabic-Indic (٠١٢٣)'));
      fireEvent.click(screen.getByTestId('profile-display-save'));
      await waitFor(() => expect(patches).toEqual([{ digitStyle: 'ARABIC_INDIC' }]));
      await waitFor(() => expect(useSession.getState().user?.digitStyle).toBe('ARABIC_INDIC'));
    },
    SLOW,
  );

  it(
    'should check the password confirmation, and put a wrong current password on its field',
    async () => {
      serve();
      let sent: unknown = null;
      server.use(
        http.post(api('users/me/password'), async ({ request }) => {
          sent = await request.json();
          return fail(400, 'VAL-001', [
            { field: 'currentPassword', message: 'validation.password.currentWrong' },
          ]);
        }),
      );
      await openProfile();
      const card = screen.getByTestId('profile-password');
      fireEvent.change(screen.getByTestId('profile-current-password'), {
        target: { value: 'Old-pass-123' },
      });
      fireEvent.change(screen.getByTestId('profile-new-password'), {
        target: { value: 'New-pass-4567' },
      });
      fireEvent.change(screen.getByTestId('profile-confirm-password'), {
        target: { value: 'New-pass-0000' },
      });
      fireEvent.click(screen.getByTestId('profile-password-save'));
      expect(await within(card).findByText('The passwords do not match.')).toBeTruthy();
      expect(sent).toBeNull();

      fireEvent.change(screen.getByTestId('profile-confirm-password'), {
        target: { value: 'New-pass-4567' },
      });
      fireEvent.click(screen.getByTestId('profile-password-save'));
      await waitFor(() =>
        expect(sent).toEqual({ currentPassword: 'Old-pass-123', newPassword: 'New-pass-4567' }),
      );
      await waitFor(() =>
        expect(
          card.querySelector('[id="currentPassword_help"], .ant-form-item-explain-error'),
        ).toBeTruthy(),
      );
    },
    SLOW,
  );

  it(
    'should save a notification switch at once; categories without email offer none',
    async () => {
      const { patches } = serve();
      await openProfile();
      const card = screen.getByTestId('profile-notifications');
      expect(within(card).queryByTestId('pref-TASKS-email')).toBeNull();
      fireEvent.click(within(card).getByTestId('pref-HEARINGS-email'));
      await waitFor(() => expect(patches).toEqual([{ prefs: { HEARINGS: { email: false } } }]));
      await waitFor(() =>
        expect(within(card).getByTestId('pref-HEARINGS-email').getAttribute('aria-checked')).toBe(
          'false',
        ),
      );
    },
    SLOW,
  );

  it(
    'should refuse a picture the browser cannot read, without uploading it',
    async () => {
      serve();
      let uploads = 0;
      server.use(
        http.post(api('users/me/avatar'), () => {
          uploads += 1;
          return ok(PROFILE);
        }),
      );
      await openProfile();
      const input = screen
        .getByTestId('profile-avatar')
        .querySelector('input[type="file"]') as HTMLInputElement;
      fireEvent.change(input, {
        target: { files: [new File(['x'], 'me.png', { type: 'image/png' })] },
      });
      expect(await screen.findByText('This image could not be read.')).toBeTruthy();
      expect(uploads).toBe(0);
    },
    SLOW,
  );

  it(
    'should save the language picked in the account menu to the profile',
    async () => {
      const { patches } = serve();
      await openProfile();
      fireEvent.click(screen.getByTestId('profile-menu'));
      fireEvent.click(await screen.findByText('Language'));
      fireEvent.click(await screen.findByTestId('menu-lang-ar'));
      await waitFor(() => expect(patches).toEqual([{ uiLanguage: 'AR' }]));
      await waitFor(() => expect(useSession.getState().user?.uiLanguage).toBe('AR'));
    },
    SLOW,
  );

  it(
    'should explain a failed load and recover on retry',
    async () => {
      server.use(
        http.get(api('users/me'), () => fail(500, 'SYS-001')),
        http.get(api('notifications/preferences'), () => ok(PREFS)),
      );
      setViewport(1280);
      signedIn();
      renderApp('/profile', 'en');
      const error = await screen.findByTestId('profile-error', {}, { timeout: COLD });
      serve();
      fireEvent.click(within(error).getByRole('button'));
      expect(await screen.findByTestId('profile-personal')).toBeTruthy();
    },
    SLOW,
  );

  it('should have no accessibility violations in Arabic', async () => {
    serve({ ...PROFILE, uiLanguage: 'AR' });
    await openProfile('ar');
    expect(document.documentElement.dir).toBe('rtl');
    expect(screen.getAllByText('حسابي')[0]).toBeTruthy();
    const { violations } = await axe.run(document.body, {
      rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
    });
    expect(violations.map((violation) => violation.id)).toEqual([]);
  }, 180_000);
});
