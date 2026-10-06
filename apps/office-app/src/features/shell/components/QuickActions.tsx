import { CheckSquareOutlined, FolderAddOutlined, PlusOutlined, UserAddOutlined } from '@ant-design/icons';
import { EmptyState, useCan } from '@nexlegtiq/shared-ui';
import { Button, Dropdown, Modal } from 'antd';
import type { MenuProps } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

type QuickAction = 'file' | 'client' | 'task';

/** + Case, + Client, + Task for who may create them. Each opens a placeholder until its feature exists. */
export function QuickActions({ compact = false }: { readonly compact?: boolean }): React.JSX.Element | null {
  const { t } = useTranslation();
  const [action, setAction] = useState<QuickAction | null>(null);
  const can = { file: useCan('create:case'), client: useCan('manage:clients'), task: useCan('create:task') };

  const items: MenuProps['items'] = [
    can.file ? { key: 'file', icon: <FolderAddOutlined />, label: t('shell.quick.file'), 'data-testid': 'quick-file' } : null,
    can.client ? { key: 'client', icon: <UserAddOutlined />, label: t('shell.quick.client'), 'data-testid': 'quick-client' } : null,
    can.task ? { key: 'task', icon: <CheckSquareOutlined />, label: t('shell.quick.task'), 'data-testid': 'quick-task' } : null,
  ].filter((item) => item !== null);

  if (items.length === 0) {
    return null;
  }
  return (
    <>
      <Dropdown menu={{ items, onClick: ({ key }) => setAction(key as QuickAction) }} trigger={['click']}>
        <Button type="primary" icon={<PlusOutlined />} aria-label={t('shell.quick.label')} data-testid="quick-actions">
          {compact ? null : t('shell.quick.label')}
        </Button>
      </Dropdown>
      <Modal open={action !== null} onCancel={() => setAction(null)} footer={null} title={action ? t(`shell.quick.${action}`) : null} data-testid="quick-placeholder">
        <EmptyState title={t('shell.comingSoon.title')} description={t('shell.comingSoon.body')} />
      </Modal>
    </>
  );
}
