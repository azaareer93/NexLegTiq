import { permissionsFor } from '@nexlegtiq/shared-types';
import type { Role } from '@nexlegtiq/shared-types';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';

import { ariaKeys, comboLabel, isHelpShortcut, SHORTCUTS } from './shortcuts';
import { renderApp, setupTestServer, setViewport, signedIn } from '../../test/render-app';

setupTestServer();

const SLOW = 60_000;
const asRole = (role: Role, locale: 'en' | 'ar' = 'en') => {
  setViewport(1280);
  signedIn({
    role,
    uiLanguage: locale === 'ar' ? 'AR' : 'EN',
    permissions: [...permissionsFor(role)],
  });
  renderApp('/', locale);
};
const help = { key: '/', code: 'Slash', ctrlKey: true };

describe('shortcut helpers', () => {
  it('should write the combos the platform way', () => {
    expect(comboLabel({ mod: 'Mod', key: 'K' }, false)).toBe('Ctrl + K');
    expect(comboLabel({ mod: 'Mod', key: 'K' }, true)).toBe('⌘ K');
    expect(comboLabel({ mod: 'CtrlAlt', key: 'N' }, false)).toBe('Ctrl + Alt + N');
    expect(comboLabel({ mod: 'CtrlAlt', key: 'N' }, true)).toBe('⌃ ⌥ N');
    expect(comboLabel({ mod: null, key: 'Esc' }, true)).toBe('Esc');
  });

  it('should name the keys for aria-keyshortcuts', () => {
    expect(ariaKeys({ mod: 'Mod', key: '/' })).toBe('Control+/ Meta+/');
    expect(ariaKeys({ mod: 'CtrlAlt', key: 'C' })).toBe('Control+Alt+C');
    expect(ariaKeys({ mod: null, key: 'Esc' })).toBe('Escape');
  });

  it('should list every shortcut of the spec once', () => {
    expect(SHORTCUTS.map((s) => comboLabel(s.combo, false))).toEqual([
      'Ctrl + K',
      'Ctrl + Alt + N',
      'Ctrl + Alt + C',
      'Ctrl + Alt + T',
      'Ctrl + Alt + U',
      'Ctrl + Alt + H',
      'Ctrl + /',
      'Esc',
    ]);
  });

  it('should take Ctrl+/ and ⌘/ by the physical key, also on an Arabic layout', () => {
    expect(isHelpShortcut(new KeyboardEvent('keydown', help))).toBe(true);
    expect(
      isHelpShortcut(new KeyboardEvent('keydown', { key: 'ظ', code: 'Slash', metaKey: true })),
    ).toBe(true);
  });

  it.each([
    ['plain /', { code: 'Slash' }],
    ['AltGr+/ (Ctrl+Alt)', { code: 'Slash', ctrlKey: true, altKey: true }],
    ['Ctrl+Shift+/', { code: 'Slash', ctrlKey: true, shiftKey: true }],
    ['a held-down Ctrl+/', { code: 'Slash', ctrlKey: true, repeat: true }],
    ['Ctrl+/ while composing', { code: 'Slash', ctrlKey: true, isComposing: true }],
  ])('should not treat %s as the help shortcut', (_case, init) => {
    expect(isHelpShortcut(new KeyboardEvent('keydown', init))).toBe(false);
  });

  it.each(['input', 'textarea', 'select', 'contenteditable'])(
    'should leave Ctrl+/ alone while typing in a %s',
    (kind) => {
      const field = document.createElement(kind === 'contenteditable' ? 'div' : kind);
      // jsdom has no isContentEditable: set it as a browser does for contenteditable="true".
      if (kind === 'contenteditable') {
        Object.defineProperty(field, 'isContentEditable', { value: true });
      }
      const event = new KeyboardEvent('keydown', help);
      Object.defineProperty(event, 'target', { value: field });
      expect(isHelpShortcut(event)).toBe(false);
    },
  );
});

describe('shortcut help modal', () => {
  it(
    'should open on Ctrl+/ with the shortcuts a lawyer may use, and close on Esc',
    async () => {
      asRole('LAWYER');
      await screen.findByTestId('page-dashboard');
      expect(fireEvent.keyDown(window, help)).toBe(false);
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText('Keyboard shortcuts')).toBeTruthy();
      expect(within(dialog).getByText('New client')).toBeTruthy();
      expect(within(dialog).getByText('Ctrl + Alt + C')).toBeTruthy();
      expect((await axe.run(dialog)).violations).toEqual([]);
      fireEvent.keyDown(dialog, { key: 'Escape', code: 'Escape' });
      await waitFor(() => expect(screen.queryByTestId('shortcut-list')).toBeNull());
    },
    SLOW,
  );

  it(
    'should list only what a trainee may do, in Arabic',
    async () => {
      asRole('TRAINEE', 'ar');
      await screen.findByTestId('page-dashboard');
      fireEvent.keyDown(window, help);
      const list = await screen.findByTestId('shortcut-list');
      expect(screen.getByText('اختصارات لوحة المفاتيح')).toBeTruthy();
      expect(within(list).getByText('البحث في كل شيء')).toBeTruthy();
      expect(
        within(list)
          .getAllByRole('listitem')
          .map((item) => item.getAttribute('data-testid')),
      ).toEqual(['shortcut-search', 'shortcut-upload', 'shortcut-help', 'shortcut-close']);
      expect((await axe.run(list)).violations).toEqual([]);
    },
    SLOW,
  );

  it(
    'should not open from a field or over another dialog',
    async () => {
      asRole('LAWYER');
      await screen.findByTestId('page-dashboard');
      expect(screen.getByTestId('search-open').getAttribute('aria-keyshortcuts')).toBe(
        'Control+K Meta+K',
      );
      fireEvent.click(screen.getByTestId('search-open'));
      const input = await screen.findByTestId('search-input');
      expect(fireEvent.keyDown(input, help)).toBe(true);
      expect(screen.queryByTestId('shortcut-list')).toBeNull();
    },
    SLOW,
  );

  it(
    'should list every shortcut a lawyer may use on /help',
    async () => {
      setViewport(1280);
      signedIn({ role: 'LAWYER', permissions: [...permissionsFor('LAWYER')] });
      renderApp('/help');
      const list = await screen.findByTestId('shortcut-list', {}, { timeout: 20_000 });
      expect(within(list).getAllByRole('listitem')).toHaveLength(SHORTCUTS.length);
    },
    SLOW,
  );
});

describe('Ctrl+Alt+C', () => {
  it(
    'should announce the quick actions their shortcuts',
    async () => {
      asRole('LAWYER');
      await screen.findByTestId('page-dashboard');
      fireEvent.click(screen.getByTestId('quick-actions'));
      await screen.findByTestId('quick-client');
      expect(
        ['file', 'client', 'task'].map((key) =>
          screen.getByTestId(`quick-${key}`).getAttribute('aria-keyshortcuts'),
        ),
      ).toEqual(['Control+Alt+N', 'Control+Alt+C', 'Control+Alt+T']);
    },
    SLOW,
  );

  it(
    'should open the client drawer for who may manage clients, but not while typing',
    async () => {
      asRole('LAWYER');
      await screen.findByTestId('page-dashboard');
      fireEvent.click(screen.getByTestId('search-open'));
      const input = await screen.findByTestId('search-input');
      expect(
        fireEvent.keyDown(input, { key: 'c', code: 'KeyC', ctrlKey: true, altKey: true }),
      ).toBe(true);
      fireEvent.keyDown(input, { key: 'Escape', code: 'Escape' });
      await waitFor(() => expect(screen.queryByTestId('search-input')).toBeNull());

      expect(
        fireEvent.keyDown(window, { key: 'c', code: 'KeyC', ctrlKey: true, altKey: true }),
      ).toBe(false);
      expect(await screen.findByTestId('client-name-input', {}, { timeout: 20_000 })).toBeTruthy();
    },
    SLOW,
  );

  it(
    'should do nothing for a trainee',
    async () => {
      asRole('TRAINEE');
      await screen.findByTestId('page-dashboard');
      expect(
        fireEvent.keyDown(window, { key: 'c', code: 'KeyC', ctrlKey: true, altKey: true }),
      ).toBe(true);
    },
    SLOW,
  );
});
