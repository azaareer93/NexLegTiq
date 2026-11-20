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

  it('should leave Ctrl+/ alone while typing in a field', () => {
    const input = document.createElement('input');
    document.body.append(input);
    const event = new KeyboardEvent('keydown', help);
    Object.defineProperty(event, 'target', { value: input });
    expect(isHelpShortcut(event)).toBe(false);
    input.remove();
  });
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
      expect(
        within(dialog).getByText('Ctrl + Alt + C').closest('[aria-keyshortcuts]'),
      ).toBeTruthy();
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
      expect(screen.queryByTestId('shortcut-newCase')).toBeNull();
      expect(screen.queryByTestId('shortcut-newClient')).toBeNull();
      expect(screen.getByTestId('shortcut-search')).toBeTruthy();
      expect(screen.getByTestId('shortcut-help')).toBeTruthy();
    },
    SLOW,
  );
});

describe('Ctrl+Alt+C', () => {
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
