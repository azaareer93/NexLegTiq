import { permissionsFor, ROLES } from '@nexlegtiq/shared-types';
import type { Role } from '@nexlegtiq/shared-types';
import { LANGUAGE_STORAGE_KEY } from '@nexlegtiq/shared-ui';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { createMemoryRouter, RouterProvider } from 'react-router';
import type { RouteObject } from 'react-router';

import { AppRoot } from '../../app/app-root';
import { routes } from '../../app/routes';
import { api, fail, http, ok, renderApp, resizeTo, server, setupTestServer, setViewport, signedIn, signOutFromMenu } from '../../test/render-app';
import { useSession } from '../auth/session';
import { initialsOf } from './components/ProfileMenu';
import { isSearchShortcut } from './components/SearchOverlay';
import { NAV_ITEMS, navKeyOf, PRIMARY_KEYS } from './nav';

setupTestServer();

const SLOW = 60_000;
const asRole = (role: Role) => signedIn({ role, permissions: [...permissionsFor(role)] });
const menuKeys = () =>
  screen
    .getAllByRole('menuitem')
    .map((item) => item.getAttribute('data-testid'))
    .filter((id): id is string => id?.startsWith('nav-') === true)
    .map((id) => id.slice('nav-'.length));
/** Menu entries are links: open one as a user would. */
const openNav = (key: string) => fireEvent.click(within(screen.getByTestId(`nav-${key}`)).getByRole('link'));
const dashboard = () => screen.findByTestId('page-dashboard');

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

/** The quick actions each role gets: + Case (create:case), + Client (manage:clients), + Task (create:task). */
const QUICK: Record<Role, string[]> = {
  OFFICE_MANAGER: ['file', 'client', 'task'],
  SENIOR_LAWYER: ['file', 'client', 'task'],
  LAWYER: ['file', 'client', 'task'],
  PARALEGAL: ['file', 'client', 'task'],
  ADMIN: ['client'],
  TRAINEE: [],
  EXTERNAL_COLLABORATOR: [],
};

describe('menu', () => {
  it('should cover every role', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...ROLES].sort());
  });

  it.each(ROLES)(
    'should show a %s only the items their role allows',
    async (role) => {
      setViewport(1280);
      asRole(role);
      renderApp('/');
      await dashboard();
      expect(menuKeys()).toEqual(EXPECTED[role]);
    },
    SLOW,
  );

  it('should open the page of a menu item through its link, and mark it as current', async () => {
    setViewport(1280);
    asRole('OFFICE_MANAGER');
    const { router } = renderApp('/');
    await dashboard();
    expect(within(screen.getByTestId('nav-team')).getByRole('link').getAttribute('href')).toBe('/team');
    openNav('team');
    expect(await screen.findByTestId('page-team')).toBeTruthy();
    expect(router.state.location.pathname).toBe('/team');
    expect(screen.getByTestId('nav-team').className).toContain('ant-menu-item-selected');
  });

  it.each([
    ['/team', 'OFFICE_MANAGER', 'team'],
    ['/settings', 'OFFICE_MANAGER', 'settings'],
    ['/reports', 'SENIOR_LAWYER', 'reports'],
    ['/clients', 'PARALEGAL', 'clients'],
    ['/documents', 'EXTERNAL_COLLABORATOR', 'documents'],
  ] as const)('should open %s for a %s typing the address', async (path, role, key) => {
    asRole(role);
    renderApp(path);
    expect(await screen.findByTestId(`page-${key}`)).toBeTruthy();
  });

  it.each([
    ['/team', 'LAWYER'],
    ['/settings', 'SENIOR_LAWYER'],
    ['/reports', 'TRAINEE'],
    ['/clients', 'EXTERNAL_COLLABORATOR'],
  ] as const)('should show the 403 page, inside the shell, when %s is opened by a %s', async (path, role) => {
    setViewport(1280);
    asRole(role);
    renderApp(path);
    const forbidden = await screen.findByTestId('page-forbidden');
    expect(screen.getByTestId('app-shell').contains(forbidden)).toBe(true);
    expect(screen.queryByTestId(`page-${path.slice(1)}`)).toBeNull();
  });

  it('should show the 404 page for an unknown address, inside the shell, with nothing selected and a way home', async () => {
    setViewport(1280);
    asRole('LAWYER');
    renderApp('/no-such-page');
    expect(await screen.findByTestId('page-not-found')).toBeTruthy();
    expect(screen.getByTestId('app-shell')).toBeTruthy();
    expect(document.querySelector('.ant-menu-item-selected')).toBeNull();
    fireEvent.click(screen.getByTestId('go-home'));
    expect(await dashboard()).toBeTruthy();
  });

  it.each(['/settings', '/no-such-page'])('should send a signed-out visitor of %s to sign-in first', async (path) => {
    useSession.setState({ status: 'anonymous' });
    const { router } = renderApp(path);
    expect(await screen.findByTestId('login-submit')).toBeTruthy();
    expect(new URLSearchParams(router.state.location.search).get('next')).toBe(path);
    expect(screen.queryByTestId('page-not-found')).toBeNull();
  });

  it('should open the account page by address for any role (it is the user\'s own)', async () => {
    asRole('TRAINEE');
    renderApp('/profile');
    expect((await screen.findByTestId('page-profile')).textContent).toContain('My account');
  });
});

describe('navigation states and errors', () => {
  /** The app's routes plus extra pages inside the shell, for loading and error cases. */
  function renderWithExtraPages(extra: RouteObject[], path: string) {
    const [root] = routes;
    // Adds `extra` next to the shell's pages (the pathless route that carries the shell's errorElement).
    const withExtra = (route: RouteObject): RouteObject => {
      const pages = route.children?.[0];
      if (route.element !== undefined && pages?.errorElement !== undefined) {
        return { ...route, children: [{ ...pages, children: [...extra, ...(pages.children ?? [])] } as RouteObject] } as RouteObject;
      }
      return { ...route, children: route.children?.map(withExtra) } as RouteObject;
    };
    const router = createMemoryRouter([withExtra(root as RouteObject)], { initialEntries: [path] });
    render(
      <AppRoot>
        <RouterProvider router={router} />
      </AppRoot>,
    );
    return router;
  }

  it('should show a skeleton inside the shell while the next page loads, then the page', async () => {
    let release: () => void = () => undefined;
    const loaded = new Promise<void>((resolve) => {
      release = resolve;
    });
    asRole('LAWYER');
    const router = renderWithExtraPages(
      [{ path: 'slow', lazy: async () => (await loaded, { Component: () => <p data-testid="page-slow">slow</p> }) }],
      '/',
    );
    await dashboard();
    void router.navigate('/slow');
    expect(await screen.findByRole('status')).toBeTruthy();
    expect(screen.getByTestId('app-shell')).toBeTruthy();
    release();
    expect(await screen.findByTestId('page-slow')).toBeTruthy();
  });

  it.each([
    ['a code chunk that failed to load', new TypeError('Failed to fetch dynamically imported module: /assets/x.js'), 'page-load-failed'],
    ['a bug', new Error('boom'), 'page-error'],
  ])('should show %s inside the shell, without its message', async (_case, error, testId) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    asRole('LAWYER');
    renderWithExtraPages(
      [
        {
          path: 'broken',
          loader: () => {
            throw error;
          },
        },
      ],
      '/broken',
    );
    const page = await screen.findByTestId(testId);
    expect(screen.getByTestId('app-shell').contains(page)).toBe(true);
    expect(document.body.textContent).not.toContain(error.message);
  });

  it('should show a thrown 404 response as the 404 page', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    asRole('LAWYER');
    renderWithExtraPages(
      [
        {
          path: 'gone',
          loader: () => {
            throw new Response('', { status: 404 });
          },
        },
      ],
      '/gone',
    );
    expect(await screen.findByTestId('page-not-found')).toBeTruthy();
  });

  it('should reload the page from the load-failed page', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    asRole('LAWYER');
    renderWithExtraPages(
      [
        {
          path: 'broken',
          loader: () => {
            throw new TypeError('Importing a module script failed.');
          },
        },
      ],
      '/broken',
    );
    fireEvent.click(within(await screen.findByTestId('page-load-failed')).getByRole('button'));
    expect(reload).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});

describe('breakpoints', () => {
  it.each([
    [1280, 'full'],
    [1200, 'full'],
    [1199, 'icons'],
    [768, 'icons'],
    [767, 'bottom'],
    [360, 'bottom'],
  ] as const)('should lay out %i px as %s navigation', async (width, layout) => {
    setViewport(width);
    asRole('OFFICE_MANAGER');
    renderApp('/');
    await dashboard();
    const sider = screen.queryByTestId('app-sider');
    if (layout === 'bottom') {
      expect(sider).toBeNull();
      expect(screen.getByTestId('bottom-nav')).toBeTruthy();
    } else {
      expect(sider?.getAttribute('data-collapsed')).toBe(layout === 'full' ? 'false' : 'true');
      expect(screen.queryByTestId('sider-toggle') !== null).toBe(layout === 'full');
      expect(screen.queryByTestId('bottom-nav')).toBeNull();
    }
  });

  it('should let the user collapse and expand the full menu, keep it across pages, and keep the items reachable', async () => {
    setViewport(1280);
    asRole('OFFICE_MANAGER');
    renderApp('/');
    await dashboard();
    const toggle = screen.getByTestId('sider-toggle');
    expect(toggle.getAttribute('aria-label')).toBe('Collapse menu');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(toggle);
    expect(screen.getByTestId('app-sider').getAttribute('data-collapsed')).toBe('true');
    expect(toggle.getAttribute('aria-label')).toBe('Expand menu');

    openNav('cases');
    expect(await screen.findByTestId('page-cases')).toBeTruthy();
    expect(screen.getByTestId('app-sider').getAttribute('data-collapsed')).toBe('true');
    expect(screen.getByTestId('nav-cases').className).toContain('ant-menu-item-selected');

    fireEvent.click(screen.getByTestId('sider-toggle'));
    expect(screen.getByTestId('app-sider').getAttribute('data-collapsed')).toBe('false');
  });

  it('should follow the window as it is resized across breakpoints', async () => {
    setViewport(1280);
    asRole('OFFICE_MANAGER');
    renderApp('/');
    await dashboard();
    resizeTo(390);
    expect(await screen.findByTestId('bottom-nav')).toBeTruthy();
    expect(screen.queryByTestId('app-sider')).toBeNull();
    fireEvent.click(screen.getByTestId('bottom-more'));
    resizeTo(1000);
    await waitFor(() => expect(screen.getByTestId('app-sider').getAttribute('data-collapsed')).toBe('true'));
    resizeTo(390);
    await screen.findByTestId('bottom-nav');
    // The drawer opened before growing does not come back by itself.
    expect(document.querySelector('.ant-drawer-open')).toBeNull();
  });

  it('should show a bottom bar on phones: links with the current page marked, and the rest of the menu behind "Menu"', async () => {
    setViewport(390);
    asRole('OFFICE_MANAGER');
    const { router } = renderApp('/');
    await dashboard();
    const bottom = screen.getByTestId('bottom-nav');
    expect(
      [...bottom.querySelectorAll('[data-testid^="bottom-"]')].map((element) => element.getAttribute('data-testid')),
    ).toEqual(['bottom-dashboard', 'bottom-cases', 'bottom-calendar', 'bottom-tasks', 'bottom-more']);
    expect(screen.getByTestId('bottom-dashboard').getAttribute('aria-current')).toBe('page');
    expect(screen.getByTestId('bottom-dashboard').textContent).toBe('Home');
    expect(screen.queryByTestId('office-name')).toBeNull();
    expect(screen.getByTestId('quick-actions').getAttribute('aria-label')).toBe('Create');

    fireEvent.click(screen.getByTestId('bottom-cases'));
    expect(await screen.findByTestId('page-cases')).toBeTruthy();
    expect(screen.getByTestId('bottom-cases').getAttribute('aria-current')).toBe('page');
    expect(screen.getByTestId('bottom-dashboard').getAttribute('aria-current')).toBeNull();

    fireEvent.click(screen.getByTestId('bottom-more'));
    openNav('settings');
    expect(await screen.findByTestId('page-settings')).toBeTruthy();
    expect(router.state.location.pathname).toBe('/settings');
    await waitFor(() => expect(document.querySelector('.ant-drawer-open')).toBeNull());
    expect(screen.getByTestId('bottom-nav').querySelector('[aria-current="page"]')).toBeNull();
  });

  it.each(['TRAINEE', 'LAWYER'] as const)('should keep the phone menu to what a %s may open', async (role) => {
    setViewport(390);
    asRole(role);
    renderApp('/');
    await dashboard();
    fireEvent.click(screen.getByTestId('bottom-more'));
    await screen.findByTestId('nav-cases');
    expect(menuKeys()).toEqual(EXPECTED[role]);
  });
});

describe('header', () => {
  beforeEach(() => setViewport(1280));

  it('should open search from the button and with Ctrl+K on an Arabic layout or Cmd+K, and close it with Escape', async () => {
    asRole('LAWYER');
    renderApp('/');
    await dashboard();
    fireEvent.click(screen.getByTestId('search-open'));
    const input = await screen.findByTestId('search-input');
    fireEvent.keyDown(input, { key: 'Escape', code: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('search-input')).toBeNull());

    expect(fireEvent.keyDown(window, { key: 'ن', code: 'KeyK', ctrlKey: true })).toBe(false);
    fireEvent.keyDown(await screen.findByTestId('search-input'), { key: 'Escape', code: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('search-input')).toBeNull());
    fireEvent.keyDown(window, { key: 'k', code: 'KeyK', metaKey: true });
    expect(await screen.findByTestId('search-input')).toBeTruthy();
  });

  it.each([
    ['plain K', { code: 'KeyK' }],
    ['Ctrl+J', { code: 'KeyJ', ctrlKey: true }],
    ['Ctrl+Shift+K', { code: 'KeyK', ctrlKey: true, shiftKey: true }],
    ['AltGr+K (Ctrl+Alt)', { code: 'KeyK', ctrlKey: true, altKey: true }],
    ['a held-down Ctrl+K', { code: 'KeyK', ctrlKey: true, repeat: true }],
    ['Ctrl+K while composing', { code: 'KeyK', ctrlKey: true, isComposing: true }],
  ])('should not treat %s as the search shortcut', (_case, init) => {
    expect(isSearchShortcut(new KeyboardEvent('keydown', init))).toBe(false);
  });

  it('should leave typing alone: a plain K opens nothing and is not swallowed', async () => {
    asRole('LAWYER');
    renderApp('/');
    await dashboard();
    expect(fireEvent.keyDown(window, { key: 'k', code: 'KeyK' })).toBe(true);
    expect(screen.queryByTestId('search-input')).toBeNull();
  });

  it.each(ROLES)(
    'should offer a %s only the quick actions they may use, each opening its placeholder',
    async (role) => {
      asRole(role);
      renderApp('/');
      await dashboard();
      const expected = QUICK[role];
      if (expected.length === 0) {
        expect(screen.queryByTestId('quick-actions')).toBeNull();
        return;
      }
      fireEvent.click(screen.getByTestId('quick-actions'));
      await screen.findByTestId(`quick-${expected[0]}`);
      expect(['file', 'client', 'task'].filter((key) => screen.queryByTestId(`quick-${key}`))).toEqual(expected);
      fireEvent.click(screen.getByTestId(`quick-${expected[0]}`));
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText({ file: 'New case', client: 'New client', task: 'New task' }[expected[0] as 'file'])).toBeTruthy();
      expect(within(dialog).getByText('Coming soon')).toBeTruthy();
    },
    SLOW,
  );

  it('should show the notifications slot with its empty state', async () => {
    asRole('LAWYER');
    renderApp('/');
    await dashboard();
    fireEvent.click(screen.getByTestId('notifications'));
    expect(await screen.findByText('No notifications yet.')).toBeTruthy();
  });

  it('should switch the language from the account menu and back, remember the pick on this device, and open my account', async () => {
    asRole('LAWYER');
    const { router } = renderApp('/');
    await dashboard();
    expect(screen.getByTestId('profile-menu').getAttribute('aria-label')).toBeNull();
    expect(screen.getByTestId('profile-menu').textContent).toContain('Layla Haddad');

    fireEvent.click(screen.getByTestId('profile-menu'));
    fireEvent.click(await screen.findByText('Language'));
    expect((await screen.findByTestId('menu-lang-en')).getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(screen.getByTestId('menu-lang-ar'));
    await waitFor(() => expect(document.documentElement.dir).toBe('rtl'));
    expect(within(screen.getByTestId('nav-cases')).getByRole('link').textContent).toBe('ملفاتي');
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('ar');

    fireEvent.click(screen.getByTestId('profile-menu'));
    fireEvent.click(await screen.findByText('اللغة'));
    fireEvent.click(await screen.findByTestId('menu-lang-en'));
    await waitFor(() => expect(document.documentElement.dir).toBe('ltr'));

    fireEvent.click(screen.getByTestId('profile-menu'));
    fireEvent.click(await screen.findByText('My account'));
    expect(await screen.findByTestId('page-profile')).toBeTruthy();
    expect(router.state.location.pathname).toBe('/profile');
  });

  it('should name the icon-only account button with its owner', async () => {
    setViewport(1000);
    asRole('LAWYER');
    renderApp('/');
    await dashboard();
    expect(screen.getByTestId('profile-menu').getAttribute('aria-label')).toBe('Account menu — Layla Haddad');
  });

  it('should sign out from the account menu', async () => {
    server.use(http.post(api('auth/logout'), () => new Response(null, { status: 204 })));
    asRole('LAWYER');
    renderApp('/');
    await dashboard();
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
    signedIn({ emailVerified: false, verifyBy: '2026-10-13T12:00:00.000Z' });
    renderApp('/');
    const banner = await screen.findByTestId('verify-banner');
    expect(banner.textContent).toContain('Please confirm your email address by 13 October 2026 to keep your access.');
    fireEvent.click(screen.getByTestId('verify-banner-resend'));
    expect((await screen.findByTestId('verify-banner-sent')).getAttribute('role')).toBe('status');
    expect(resent).toEqual({ email: 'layla@example.test' });
  });

  it('should give the Arabic deadline with Western digits', async () => {
    signedIn({ emailVerified: false, verifyBy: '2026-10-13T12:00:00.000Z', uiLanguage: 'AR' });
    renderApp('/');
    expect((await screen.findByTestId('verify-banner')).textContent).toContain('قبل 13 أكتوبر 2026');
  });

  it('should leave the deadline out when there is none', async () => {
    signedIn({ emailVerified: false, verifyBy: null });
    renderApp('/');
    expect((await screen.findByTestId('verify-banner')).textContent).toContain('Please confirm your email address. We sent you a link when you signed up.');
  });

  it('should say why a new link could not be sent, and let the user try again', async () => {
    server.use(http.post(api('auth/resend-verification'), () => fail(429, 'RATE-001')));
    signedIn({ emailVerified: false, verifyBy: null });
    renderApp('/');
    fireEvent.click(await screen.findByTestId('verify-banner-resend'));
    expect((await screen.findByTestId('verify-banner-error')).textContent).toBe('Too many requests. Wait a moment and try again.');
    expect(screen.queryByTestId('verify-banner-sent')).toBeNull();
    expect((screen.getByTestId('verify-banner-resend') as HTMLButtonElement).disabled).toBe(false);
  });

  it('should not show for a confirmed user', async () => {
    signedIn();
    renderApp('/');
    await dashboard();
    expect(screen.queryByTestId('verify-banner')).toBeNull();
  });
});

describe('right-to-left', () => {
  it('should lay the shell out right to left in Arabic, with the side menu first in reading order (on the right)', async () => {
    setViewport(1280);
    signedIn({ uiLanguage: 'AR' });
    renderApp('/');
    await dashboard();
    expect(document.documentElement.dir).toBe('rtl');
    const shell = screen.getByTestId('app-shell');
    expect(shell.className).toContain('ant-layout-rtl');
    expect(shell.firstElementChild).toBe(screen.getByTestId('app-sider'));
    expect(screen.getByRole('menu').className).toContain('ant-menu-rtl');
    expect(screen.getByTestId('sider-toggle').querySelector('[style*="scaleX(-1)"]')).not.toBeNull();
    expect(menuKeys().map((key) => screen.getByTestId(`nav-${key}`).textContent)).toEqual([
      'لوحة المعلومات',
      'ملفاتي',
      'الموكلون',
      'التقويم',
      'المهام',
      'المستندات',
      'التقارير',
      'الفريق',
      'الإعدادات',
    ]);
  });

  it.each([
    ['ar', 1280],
    ['en', 1280],
    ['ar', 390],
  ] as const)(
    'should be accessible in %s at %i px',
    async (locale, width) => {
      setViewport(width);
      signedIn({ uiLanguage: locale === 'ar' ? 'AR' : 'EN', emailVerified: false });
      renderApp('/');
      await dashboard();
      const { violations } = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } });
      expect(violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`)).toEqual([]);
    },
    SLOW,
  );
});

describe('nav helpers', () => {
  it('should give every item a distinct path, and only menu keys to the bottom bar', () => {
    expect(new Set(NAV_ITEMS.map((item) => item.path)).size).toBe(NAV_ITEMS.length);
    expect(PRIMARY_KEYS.every((key) => NAV_ITEMS.some((item) => item.key === key))).toBe(true);
  });

  it.each([
    ['/', 'dashboard'],
    ['/cases', 'cases'],
    ['/cases/123', 'cases'],
    ['/profile', undefined],
    ['/clientsfoo', undefined],
    ['/x', undefined],
  ])('should map %s to the %s item', (path, key) => {
    expect(navKeyOf(path)).toBe(key);
  });

  it.each([
    ['Layla Haddad', 'LH'],
    ['ليلى حداد', 'ل‌ح'],
    ['omar', 'O'],
    ['', ''],
  ])('should make the avatar initials of %j', (name, initials) => {
    expect(initialsOf(name)).toBe(initials);
  });
});
