import {
  CheckSquareOutlined,
  FolderAddOutlined,
  PlusOutlined,
  UserAddOutlined,
} from '@ant-design/icons';
import { EmptyState, useCan } from '@nexlegtiq/shared-ui';
import { Button, Dropdown, Modal } from 'antd';
import type { MenuProps } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { openQuickCreateCase } from '../../cases';
import { ClientDrawer } from '../../clients';

const QUICK_ACTIONS = ['file', 'client', 'task'] as const;
type QuickAction = (typeof QUICK_ACTIONS)[number];
const isQuickAction = (key: string): key is QuickAction =>
  (QUICK_ACTIONS as readonly string[]).includes(key);

/** + Case, + Client, + Task for who may create them: the quick-create case modal, the client drawer, and a placeholder for tasks. */
export function QuickActions({
  compact = false,
}: {
  readonly compact?: boolean;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
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
    else if (isQuickAction(key)) setOpen(true);
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
      <Modal
        open={open}
        onCancel={() => setOpen(false)}
        footer={null}
        title={t('shell.quick.task')}
        data-testid="quick-placeholder"
      >
        <EmptyState title={t('shell.comingSoon.title')} description={t('shell.comingSoon.body')} />
      </Modal>
      <ClientDrawer open={clientOpen} clientId={null} onClose={() => setClientOpen(false)} />
    </>
  );
}
