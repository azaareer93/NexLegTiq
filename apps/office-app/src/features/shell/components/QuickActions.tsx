import {
  CheckSquareOutlined,
  FolderAddOutlined,
  PlusOutlined,
  UserAddOutlined,
} from '@ant-design/icons';
import { useCan } from '@nexlegtiq/shared-ui';
import { Button, Dropdown } from 'antd';
import type { MenuProps } from 'antd';
import { lazy, Suspense, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { openQuickCreateCase } from '../../cases';
import { openTaskDrawer } from '../../tasks';

// Its own chunk, loaded the first time + Client is used (as the case modal is).
const ClientDrawer = lazy(async () => ({
  default: (await import('../../clients/components/ClientDrawer')).ClientDrawer,
}));

const QUICK_ACTIONS = ['file', 'client', 'task'] as const;
type QuickAction = (typeof QUICK_ACTIONS)[number];
const isQuickAction = (key: string): key is QuickAction =>
  (QUICK_ACTIONS as readonly string[]).includes(key);

/** + Case, + Client, + Task for who may create them: the quick-create case modal, the client drawer, the task drawer. */
export function QuickActions({
  compact = false,
}: {
  readonly compact?: boolean;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const [clientOpen, setClientOpen] = useState(false);
  const can: Record<QuickAction, boolean> = {
    file: useCan('create:case'),
    client: useCan('manage:clients'),
    task: useCan('create:task'),
  };

  const icons: Record<QuickAction, React.JSX.Element> = {
    file: <FolderAddOutlined />,
    client: <UserAddOutlined />,
    task: <CheckSquareOutlined />,
  };
  const items: MenuProps['items'] = QUICK_ACTIONS.filter((key) => can[key]).map((key) => ({
    key,
    icon: icons[key],
    label: t(`shell.quick.${key}`),
    'data-testid': `quick-${key}`,
  }));

  if (items.length === 0) {
    return null;
  }
  const onClick: MenuProps['onClick'] = ({ key }) => {
    if (key === 'file') openQuickCreateCase();
    else if (key === 'client') setClientOpen(true);
    else if (isQuickAction(key)) openTaskDrawer();
  };
  return (
    <>
      <Dropdown menu={{ items, onClick }} trigger={['click']}>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          aria-label={compact ? t('shell.quick.label') : undefined}
          data-testid="quick-actions"
        >
          {compact ? null : t('shell.quick.label')}
        </Button>
      </Dropdown>
      {clientOpen ? (
        <Suspense fallback={null}>
          <ClientDrawer open clientId={null} onClose={() => setClientOpen(false)} />
        </Suspense>
      ) : null}
    </>
  );
}
