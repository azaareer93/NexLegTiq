import { useCan } from '@nexlegtiq/shared-ui';
import { useMatch } from 'react-router';

import { TaskDrawer } from './TaskDrawer';
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
  useCtrlAltShortcut('KeyT', canCreate && !open, () =>
    openTaskDrawer(onFile?.params.id ? { fileId: onFile.params.id } : {}),
  );
  return open ? <TaskDrawer /> : null;
}
