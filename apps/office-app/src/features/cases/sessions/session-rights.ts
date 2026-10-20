import type { Case } from '@nexlegtiq/shared-contracts';
import { useCan } from '@nexlegtiq/shared-ui';
import { useEffect } from 'react';

import type { SessionRights } from './SessionDrawer';
import { isAssigned } from '../file-page';
import { isCtrlAltShortcut } from '../quick-create';

/**
 * What the user may do with the file's hearings (D-116; UI only): schedule with `create:session`; edit, cancel and record
 * outcomes with `edit:session` and write access to the file. Nothing on an archived file.
 */
export function useSessionRights(file: Case, userId: string): SessionRights {
  const create = useCan('create:session');
  const edit = useCan('edit:session');
  const editAny = useCan('edit:any:case');
  const editAssigned = useCan('edit:assigned:case');
  const open = file.status !== 'ARCHIVED';
  return {
    create: open && create,
    edit: open && edit && (editAny || (editAssigned && isAssigned(file, userId))),
  };
}

/** Opens the hearing drawer on Ctrl+Alt+H (the physical key) while the file page is shown. */
export function useHearingShortcut(enabled: boolean, open: () => void): void {
  useEffect(() => {
    if (!enabled) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (isCtrlAltShortcut(event, 'KeyH')) {
        event.preventDefault();
        open();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled, open]);
}
