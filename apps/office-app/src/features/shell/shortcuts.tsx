import { useCan } from '@nexlegtiq/shared-ui';
import { List, Modal, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { isTyping } from '../cases';

/** Apple devices write ⌘ for the Ctrl/Cmd shortcuts and ⌃ ⌥ for Control+Option; key names are not translated. */
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** `Mod` is Ctrl, or ⌘ on a Mac (either is accepted); `Ctrl+Alt` is Control+Option on a Mac. */
/** The permissions the listed handlers check; `ShortcutList` must hold one `useCan` per member. */
type ShortcutPermission =
  'create:case' | 'manage:clients' | 'create:task' | 'upload:document' | 'create:session';

type Combo = { readonly mod: 'Mod' | 'CtrlAlt' | null; readonly key: string };

interface Shortcut {
  /** `help.shortcuts.<action>` */
  readonly action: string;
  readonly combo: Combo;
  /** Listed only for users who may do it — the handlers check the same permission. */
  readonly permission?: ShortcutPermission;
}

/** Every shortcut of the office app (frontend.md#keyboard-shortcuts, D-190): the help modal and `/help` list these. */
export const SHORTCUTS: readonly Shortcut[] = [
  { action: 'search', combo: { mod: 'Mod', key: 'K' } },
  { action: 'newCase', combo: { mod: 'CtrlAlt', key: 'N' }, permission: 'create:case' },
  { action: 'newClient', combo: { mod: 'CtrlAlt', key: 'C' }, permission: 'manage:clients' },
  { action: 'newTask', combo: { mod: 'CtrlAlt', key: 'T' }, permission: 'create:task' },
  { action: 'upload', combo: { mod: 'CtrlAlt', key: 'U' }, permission: 'upload:document' },
  { action: 'newHearing', combo: { mod: 'CtrlAlt', key: 'H' }, permission: 'create:session' },
  { action: 'help', combo: { mod: 'Mod', key: '/' } },
  { action: 'close', combo: { mod: null, key: 'Esc' } },
];

/** How the combo is written on this platform, e.g. `Ctrl + Alt + N` or `⌃ ⌥ N`. */
export function comboLabel({ mod, key }: Combo, mac = IS_MAC): string {
  const prefix =
    mod === 'Mod'
      ? [mac ? '⌘' : 'Ctrl']
      : mod === 'CtrlAlt'
        ? mac
          ? ['⌃', '⌥']
          : ['Ctrl', 'Alt']
        : [];
  return [...prefix, key].join(mac ? ' ' : ' + ');
}

/** The `aria-keyshortcuts` value (WAI-ARIA key names), e.g. `Control+Alt+N`. */
export function ariaKeys({ mod, key }: Combo): string {
  const name = key === 'Esc' ? 'Escape' : key;
  if (mod === 'Mod') return `Control+${name} Meta+${name}`;
  return mod === 'CtrlAlt' ? `Control+Alt+${name}` : name;
}

/** Ctrl+Alt+<key> (D-123's rule, `isCtrlAltShortcut`) as `aria-keyshortcuts`, for the control the shortcut triggers. */
export const ctrlAltAria = (key: string): string => ariaKeys({ mod: 'CtrlAlt', key });

/**
 * Ctrl+/ (⌘/ on a Mac) by the physical key, so it works on an Arabic layout; not with Alt (AltGr) or Shift, on
 * auto-repeat, while composing or while typing in a field.
 */
export const isHelpShortcut = (event: KeyboardEvent): boolean =>
  (event.ctrlKey || event.metaKey) &&
  !event.altKey &&
  !event.shiftKey &&
  !event.repeat &&
  !event.isComposing &&
  event.code === 'Slash' &&
  !isTyping(event.target);

/** The shortcuts this user may use, with localized labels; shared by the help modal and the `/help` page. */
export function ShortcutList(): React.JSX.Element {
  const { t } = useTranslation();
  // One hook per permission the list names (a fixed set, so hooks stay unconditional).
  const allowed: Record<ShortcutPermission, boolean> = {
    'create:case': useCan('create:case'),
    'manage:clients': useCan('manage:clients'),
    'create:task': useCan('create:task'),
    'upload:document': useCan('upload:document'),
    'create:session': useCan('create:session'),
  };
  const visible = SHORTCUTS.filter((s) => !s.permission || allowed[s.permission]);
  return (
    <List
      size="small"
      dataSource={visible}
      data-testid="shortcut-list"
      renderItem={(s) => (
        <List.Item data-testid={`shortcut-${s.action}`}>
          <span>{t(`help.shortcuts.${s.action}`)}</span>
          <Typography.Text keyboard>
            <span dir="ltr">{comboLabel(s.combo)}</span>
          </Typography.Text>
        </List.Item>
      )}
    />
  );
}

/** Mounted once in the shell: Ctrl+/ opens the shortcut list; Esc (AntD) closes it. */
export function ShortcutsHelp(): React.JSX.Element {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Not over another dialog, as the Ctrl+Alt shortcuts (D-133).
      if (document.activeElement?.closest('[role="dialog"]')) return;
      if (isHelpShortcut(event)) {
        event.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
  return (
    <Modal
      open={open}
      onCancel={() => setOpen(false)}
      footer={null}
      title={t('help.shortcuts.title')}
      destroyOnHidden
    >
      <ShortcutList />
    </Modal>
  );
}
