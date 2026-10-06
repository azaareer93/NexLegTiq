import { permissionsFor, ROLES } from '@nexlegtiq/shared-types';
import type { Role } from '@nexlegtiq/shared-types';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';

import { api, http, ok, renderApp, server, setupTestServer, setViewport, signedIn, signOutFromMenu } from '../../test/render-app';
import { useSession } from '../auth/session';
import { NAV_ITEMS } from './nav';

setupTestServer();

const asRole = (role: Role) => signedIn({ role, permissions: [...permissionsFor(role)] });
const menuKeys = () =>
  screen
    .getAllByRole('menuitem')
    .map((item) => item.getAttribute('data-testid'))
    .filter((id): id is string => id?.startsWith('nav-') === true)
    .map((id) => id.slice('nav-'.length));

/** The menu each role sees (D-091). */
const EXPECTED: Record<Role, string[]> = {
  OFFICE_MANAGER: ['dashboard', 'cases', 'clients', 'calendar', 'tasks', 'documents', 'reports', 'team', 'settings'],
  SENIOR_LAWYER: ['dashboard', 'cases', 'clients', 'calendar', 'tasks', 'documents', 'reports'],
  LAWYER: ['dashboard', 'cases', 'clients', 'calendar', 'tasks', 'documents'],
  PARALEGAL: ['dashboard', 'cases', 'clients', 'calendar', 'tasks', 'documents'],
  ADMIN: ['dashboard', 'cases', 'clients', 'calendar', 'tasks', 'documents', 'reports'],
  TRAINEE: ['dashboard', 'cases', 'calendar', 'tasks', 'documents'],
  EXTERNAL_COLLABORATOR: ['dashboard', 'cases', 'calendar', 'tasks', 'documents'],
};

describe('menu', () => {
  it('should cover every role', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...ROLES].sort());
  });

  it.each(ROLES)('should show a %s only the items their role allows', async (role) => {
    setViewport(1280);
    asRole(role);
    renderApp('/');
    await screen.findByTestId('page-dashboard');
    expect(menuKeys()).toEqual(EXPECTED[role]);
  });

  it('should open the page of a menu item and mark it as current', async () => {
    setViewport(1280);
    asRole('OFFICE_MANAGER');
    const { router } = renderApp('/');
    await screen.findByTestId('page-dashboard');
    fireEvent.click(screen.getByTestId('nav-team'));
    expect(await screen.findByTestId('page-team')).toBeTruthy();
    expect(router.state.location.pathname).toBe('/team');
    expect(screen.getByTestId('nav-team').className).toContain('ant-menu-item-selected');
  });

  it.each([
    ['/team', 'LAWYER'],
    ['/settings', 'SENIOR_LAWYER'],
    ['/reports', 'TRAINEE'],
    ['/clients', 'EXTERNAL_COLLABORATOR'],
  ] as const)('should show the 403 page when %s is opened by a %s', async (path, role) => {
    asRole(role);
    renderApp(path);
    expect(await screen.findByTestId('page-forbidden')).toBeTruthy();
  });

  it('should show the 404 page for an unknown address, inside the shell', async () => {
    asRole('LAWYER');
    renderApp('/no-such-page');
    expect(await screen.findByTestId('page-not-found')).toBeTruthy();
    expect(screen.getByTestId('app-shell')).toBeTruthy();
    expect(screen.getByTestId('go-home').getAttribute('href')).toBe('/');
  });

  it('should send a signed-out visitor of any page to sign-in first', async () => {
    useSession.setState({ status: 'anonymous' });
    const { router } = renderApp('/settings');
    expect(await screen.findByTestId('login-submit')).toBeTruthy();
    expect(new URLSearchParams(router.state.location.search).get('next')).toBe('/settings');
  });
});

describe('breakpoints', () => {
  it('should show the full side menu at 1200 px and wider, which the user can collapse', async () => {
    setViewport(1280);
    asRole('OFFICE_MANAGER');
    renderApp('/');
    await screen.findByTestId('page-dashboard');
    expect(screen.getByTestId('app-sider').getAttribute('data-collapsed')).toBe('false');
    expect(screen.getByTestId('office-name').textContent).toBe('Haddad Law');
    expect(screen.queryByTestId('bottom-nav')).toBeNull();
    fireEvent.click(screen.getByTestId('app-sider').querySelector('.ant-layout-sider-trigger') as Element);
    expect(screen.getByTestId('app-sider').getAttribute('data-collapsed')).toBe('true');
  });

  it('should show an icon-only side menu from 768 to 1199 px', async () => {
    setViewport(1000);
    asRole('OFFICE_MANAGER');
    renderApp('/');
    await screen.findByTestId('page-dashboard');
    const sider = screen.getByTestId('app-sider');
    expect(sider.getAttribute('data-collapsed')).toBe('true');
    expect(sider.querySelector('.ant-layout-sider-trigger')).toBeNull();
    expect(screen.queryByTestId('bottom-nav')).toBeNull();
  });

  it('should show a bottom bar under 768 px, with the rest of the menu behind "Menu"', async () => {
    setViewport(390);
    asRole('OFFICE_MANAGER');
    const { router } = renderApp('/');
    await screen.findByTestId('page-dashboard');
    expect(screen.queryByTestId('app-sider')).toBeNull();
    const bottom = screen.getByTestId('bottom-nav');
    expect(within(bottom).getAllByRole('button').map((button) => button.getAttribute('data-testid'))).toEqual([
      'bottom-dashboard',
      'bottom-cases',
      'bottom-calendar',
      'bottom-tasks',
      'bottom-more',
    ]);
    expect(screen.getByTestId('bottom-dashboard').getAttribute('aria-current')).toBe('page');

    fireEvent.click(screen.getByTestId('bottom-more'));
    fireEvent.click(await screen.findByTestId('nav-settings'));
    expect(await screen.findByTestId('page-settings')).toBeTruthy();
    expect(router.state.location.pathname).toBe('/settings');
  });
});

describe('header', () => {
  beforeEach(() => setViewport(1280));

  it('should open the search overlay with Ctrl+K, also on an Arabic keyboard layout, and with Cmd+K', async () => {
    asRole('LAWYER');
    renderApp('/');
    await screen.findByTestId('page-dashboard');
    fireEvent.keyDown(window, { key: 'ن', code: 'KeyK', ctrlKey: true });
    expect(await screen.findByTestId('search-input')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByTestId('search-input')).toBeNull());
    fireEvent.keyDown(window, { key: 'k', code: 'KeyK', metaKey: true });
    expect(await screen.findByTestId('search-input')).toBeTruthy();
  });

  it.each([
    ['OFFICE_MANAGER', ['quick-file', 'quick-client', 'quick-task']],
    ['ADMIN', ['quick-client']],
  ] as const)('should offer a %s only the quick actions they may use, each opening a placeholder', async (role, expected) => {
    asRole(role);
    renderApp('/');
    await screen.findByTestId('page-dashboard');
    fireEvent.click(screen.getByTestId('quick-actions'));
    await screen.findByTestId(expected[0]);
    expect(['quick-file', 'quick-client', 'quick-task'].filter((id) => screen.queryByTestId(id))).toEqual(expected);
    fireEvent.click(screen.getByTestId(expected[0]));
    expect(within(await screen.findByRole('dialog')).getByText('Coming soon')).toBeTruthy();
  });

  it.each(['TRAINEE', 'EXTERNAL_COLLABORATOR'] as const)('should hide quick actions from a %s, who can create nothing', async (role) => {
    asRole(role);
    renderApp('/');
    await screen.findByTestId('page-dashboard');
    expect(screen.queryByTestId('quick-actions')).toBeNull();
  });

  it('should switch the language from the account menu and open the profile page', async () => {
    asRole('LAWYER');
    const { router } = renderApp('/');
    await screen.findByTestId('page-dashboard');
    expect(document.documentElement.dir).toBe('ltr');
    fireEvent.click(screen.getByTestId('profile-menu'));
    fireEvent.mouseEnter(await screen.findByText('Language'));
    fireEvent.click(await screen.findByText('العربية'));
    await waitFor(() => expect(document.documentElement.dir).toBe('rtl'));
    expect(screen.getByTestId('nav-cases').textContent).toBe('ملفاتي');

    fireEvent.click(screen.getByTestId('profile-menu'));
    fireEvent.click(await screen.findByText('ملفي الشخصي'));
    expect(await screen.findByTestId('page-profile')).toBeTruthy();
    expect(router.state.location.pathname).toBe('/profile');
  });

  it('should sign out from the account menu', async () => {
    server.use(http.post(api('auth/logout'), () => new Response(null, { status: 204 })));
    asRole('LAWYER');
    renderApp('/');
    await screen.findByTestId('page-dashboard');
    await signOutFromMenu();
    expect(await screen.findByTestId('login-notice')).toBeTruthy();
  });
});

describe('email confirmation banner', () => {
  it('should ask an unconfirmed user to confirm by the deadline, and send a new link', async () => {
    let resent: unknown;
    server.use(
      http.post(api('auth/resend-verification'), async ({ request }) => {
        resent = await request.json();
        return ok(null, 202);
      }),
    );
    signedIn({ emailVerified: false, verifyBy: '2026-10-13T10:00:00.000Z' });
    renderApp('/');
    const banner = await screen.findByTestId('verify-banner');
    expect(banner.textContent).toContain('Confirm it by October 13, 2026');
    fireEvent.click(screen.getByTestId('verify-banner-resend'));
    expect(await screen.findByTestId('verify-banner-sent')).toBeTruthy();
    expect(resent).toEqual({ email: 'layla@example.test' });
  });

  it('should not show for a confirmed user', async () => {
    signedIn();
    renderApp('/');
    await screen.findByTestId('page-dashboard');
    expect(screen.queryByTestId('verify-banner')).toBeNull();
  });
});

describe('right-to-left', () => {
  it('should lay the shell out right to left in Arabic, with the side menu first in reading order (on the right)', async () => {
    setViewport(1280);
    signedIn({ uiLanguage: 'AR' });
    renderApp('/');
    await screen.findByTestId('page-dashboard');
    expect(document.documentElement.dir).toBe('rtl');
    const shell = screen.getByTestId('app-shell');
    expect(shell.className).toContain('ant-layout-rtl');
    expect(shell.firstElementChild).toBe(screen.getByTestId('app-sider'));
    expect(screen.getByRole('menu').className).toContain('ant-menu-rtl');
    expect(menuKeys().map((key) => screen.getByTestId(`nav-${key}`).textContent)).toEqual(
      ['لوحة المعلومات', 'ملفاتي', 'الموكلون', 'التقويم', 'المهام', 'المستندات', 'التقارير', 'الفريق', 'الإعدادات'],
    );
  });

  it.each(['ar', 'en'] as const)(
    'should be accessible in %s',
    async (locale) => {
      setViewport(1280);
      signedIn({ uiLanguage: locale === 'ar' ? 'AR' : 'EN', emailVerified: false });
      renderApp('/');
      await screen.findByTestId('page-dashboard');
      const { violations } = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } });
      expect(violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`)).toEqual([]);
    },
    60_000,
  );
});

describe('NAV_ITEMS', () => {
  it('should give every item a distinct path', () => {
    expect(new Set(NAV_ITEMS.map((item) => item.path)).size).toBe(NAV_ITEMS.length);
  });
});
