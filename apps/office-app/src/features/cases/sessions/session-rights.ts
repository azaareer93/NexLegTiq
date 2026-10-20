import type { Case } from '@nexlegtiq/shared-contracts';
import { useCan } from '@nexlegtiq/shared-ui';
import { useEffect, useRef } from 'react';

import { isAssigned } from '../file-page';
import { isCtrlAltShortcut } from '../quick-create';

/** What the user may do with hearings on this file (UI only; the API re-checks, D-116). */
export interface SessionRights {
  /** `create:session` with write access to a file that is not archived. */
  readonly create: boolean;
  /** `edit:session` with write access to a file that is not archived. */
  readonly edit: boolean;
}

/**
 * The API asks for write access to the file for every hearing write (`edit:any:case`, or `edit:assigned:case` when
 * assigned), on top of `create:session` or `edit:session`; nothing on an archived file (D-052).
 */
export function useSessionRights(file: Case, userId: string): SessionRights {
  const create = useCan('create:session');
  const edit = useCan('edit:session');
  const editAny = useCan('edit:any:case');
  const editAssigned = useCan('edit:assigned:case');
  const writable =
    file.status !== 'ARCHIVED' && (editAny || (editAssigned && isAssigned(file, userId)));
  return { create: writable && create, edit: writable && edit };
}

/** Opens the hearing drawer on Ctrl+Alt+H (the physical key) while `enabled` (no other dialog open). */
export function useHearingShortcut(enabled: boolean, open: () => void): void {
  // The latest callback, so the listener is attached once per `enabled` change, not on every render.
  const latest = useRef(open);
  latest.current = open;
  useEffect(() => {
    if (!enabled) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (isCtrlAltShortcut(event, 'KeyH')) {
        event.preventDefault();
        latest.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}
