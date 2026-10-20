import { create } from 'zustand';

/** Whether the quick-create case modal is open (D-123): opened from the shell, the cases list or Ctrl+Alt+N. */
export const useQuickCreateCase = create<{ readonly open: boolean }>(() => ({ open: false }));

export const openQuickCreateCase = (): void => useQuickCreateCase.setState({ open: true });
export const closeQuickCreateCase = (): void => useQuickCreateCase.setState({ open: false });

const EDITABLE = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/**
 * Ctrl+Alt+<key> by the physical key (`code`, so it works on an Arabic layout), not on auto-repeat or while composing.
 * Ignored while typing in a field: on Windows Ctrl+Alt is AltGr, which some layouts use to type characters.
 */
export function isCtrlAltShortcut(event: KeyboardEvent, code: string): boolean {
  return (
    !isTyping(event.target) &&
    event.ctrlKey &&
    event.altKey &&
    !event.shiftKey &&
    !event.metaKey &&
    !event.repeat &&
    !event.isComposing &&
    event.code === code
  );
}

/** Ctrl+Alt+N: a new case (D-123). */
export const isNewCaseShortcut = (event: KeyboardEvent): boolean =>
  isCtrlAltShortcut(event, 'KeyN');

const isTyping = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement && (target.isContentEditable || EDITABLE.has(target.tagName));
