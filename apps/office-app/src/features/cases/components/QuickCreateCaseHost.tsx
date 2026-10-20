import { useCan } from '@nexlegtiq/shared-ui';
import { lazy, Suspense, useEffect } from 'react';

import { isNewCaseShortcut, openQuickCreateCase, useQuickCreateCase } from '../quick-create';

// Its own chunk: the form (with the client and court pickers) loads the first time it opens.
const QuickCreateCaseModal = lazy(async () => ({
  default: (await import('./QuickCreateCaseModal')).QuickCreateCaseModal,
}));

/** Mounted once in the shell: Ctrl+Alt+N and the modal itself, for who may create files (`create:case`). */
export function QuickCreateCaseHost(): React.JSX.Element | null {
  const canCreate = useCan('create:case');
  const open = useQuickCreateCase((state) => state.open);

  useEffect(() => {
    if (!canCreate) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (isNewCaseShortcut(event)) {
        event.preventDefault();
        openQuickCreateCase();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canCreate]);

  return canCreate && open ? (
    <Suspense fallback={null}>
      <QuickCreateCaseModal />
    </Suspense>
  ) : null;
}
