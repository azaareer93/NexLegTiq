import { PlusOutlined } from '@ant-design/icons';
import { conditionFor } from '@nexlegtiq/shared-types';
import { useCan } from '@nexlegtiq/shared-ui';
import { Button, Flex, Grid, Segmented } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { TaskBoard } from './TaskBoard';
import type { BoardRights } from './TaskBoard';
import { TaskList } from './TaskList';
import type { TaskFilters } from './TaskList';
import { useSession } from '../../auth';
import type { TaskScope } from '../api/use-tasks';
import { openTaskDrawer } from '../task-drawer';

type View = 'board' | 'list';

/** What the board lets the caller do (UI only; the API re-checks, D-098). */
function useBoardRights(scope: TaskScope, readOnly: boolean): BoardRights {
  const user = useSession((state) => state.user);
  return {
    move: useCan('complete:task'),
    // Positions are office-wide per column (D-098): saved on a file's board only, never from My tasks' mixed columns.
    reorder: useCan('create:task') && 'fileId' in scope,
    readOnly,
    // An outside collaborator moves only tasks assigned to them (D-098: `complete:task` is OWN for that role).
    onlyOwn: user ? conditionFor(user.role, 'complete:task') === 'OWN' : true,
    me: user?.id ?? '',
  };
}

/**
 * Tasks of a file (its Tasks tab) or of the caller (`/tasks`): the board or the list, "New task". Phones start on the
 * list (four columns do not fit); the choice is kept while the page is open.
 */
export function TasksView({
  scope,
  readOnly = false,
}: {
  readonly scope: TaskScope;
  /** An archived file (D-052). */
  readonly readOnly?: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const screens = Grid.useBreakpoint();
  const [chosen, setChosen] = useState<View | null>(null);
  const [filters, setFilters] = useState<TaskFilters>({});
  const canCreate = useCan('create:task') && !readOnly;
  const rights = useBoardRights(scope, readOnly);
  // `md` is undefined until the first measurement: the board is the default on a wide screen.
  const view: View = chosen ?? (screens.md === false ? 'list' : 'board');

  return (
    <Flex vertical gap={12} data-testid="tasks-view">
      <Flex justify="space-between" align="center" gap={8} wrap>
        <Segmented<View>
          value={view}
          onChange={setChosen}
          options={[
            { value: 'board', label: t('tasks.view.board') },
            { value: 'list', label: t('tasks.view.list') },
          ]}
          aria-label={t('tasks.view.label')}
          data-testid="tasks-view-toggle"
        />
        {canCreate ? (
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => openTaskDrawer('fileId' in scope ? { fileId: scope.fileId } : {})}
            data-testid="task-add"
          >
            {t('tasks.add')}
          </Button>
        ) : null}
      </Flex>
      {view === 'board' ? (
        <TaskBoard scope={scope} rights={rights} />
      ) : (
        <TaskList scope={scope} filters={filters} onFilters={setFilters} readOnly={readOnly} />
      )}
    </Flex>
  );
}
