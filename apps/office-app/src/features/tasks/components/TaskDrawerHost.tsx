import type { Case } from '@nexlegtiq/shared-contracts';
import { useCan } from '@nexlegtiq/shared-ui';
import { useQueryClient } from '@tanstack/react-query';
import { useMatch } from 'react-router';

import { TaskDrawer } from './TaskDrawer';
import { caseKeys } from '../../cases/api/use-cases';
import { useCtrlAltShortcut } from '../../cases/quick-create';
import { openTaskDrawer, useTaskDrawer } from '../task-drawer';

/**
 * Mounted once in the shell: the task drawer, and Ctrl+Alt+T (physical `KeyT`, D-123's rule) for a new task — on a file's
 * page it belongs to that file, elsewhere it is personal.
 */
export function TaskDrawerHost(): React.JSX.Element | null {
  const canCreate = useCan('create:task');
  const open = useTaskDrawer((state) => state.open);
  const onFile = useMatch('/cases/:id');
  const queryClient = useQueryClient();
  useCtrlAltShortcut('KeyT', canCreate && !open, () => {
    const fileId = onFile?.params.id;
    if (!fileId) return openTaskDrawer();
    // An archived file takes no new tasks (D-052): the shortcut does nothing there.
    const file = queryClient.getQueryData<Case>(caseKeys.detail(fileId));
    if (file?.status !== 'ARCHIVED') openTaskDrawer({ fileId });
  });
  return open ? <TaskDrawer /> : null;
}
