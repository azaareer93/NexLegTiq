import { EditOutlined, LockOutlined, MoreOutlined } from '@ant-design/icons';
import type { Case } from '@nexlegtiq/shared-contracts';
import { isErrorCode } from '@nexlegtiq/shared-types';
import {
  Bdi,
  ConfirmModal,
  EmptyState,
  ErrorState,
  isApiError,
  LoadingSkeleton,
  Ltr,
  PageHeader,
  PriorityTag,
  useApiErrorHandler,
} from '@nexlegtiq/shared-ui';
import { Alert, App, Button, Dropdown, Flex, Modal, Tabs, Tag, Typography } from 'antd';
import type { MenuProps } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router';

import { useSession } from '../../auth';
import { NotFoundPage } from '../../shell/components/status-pages';
import { useCase, useDeleteCase } from '../api/use-cases';
import { FileStatusTag } from '../components/case-cells';
import { CaseDetailsTab } from '../components/CaseDetailsTab';
import { EditCaseDrawer } from '../components/EditCaseDrawer';
import { fileActions, readTab, visibleTabs } from '../file-page';
import type { FileActions, FileTab } from '../file-page';

type Dialog = 'edit' | 'delete' | 'comingSoon' | null;

/** The ⋮ menu: only the actions the user may take (UI only; the API re-checks, D-051). */
function ActionsMenu({
  actions,
  onPick,
}: {
  readonly actions: FileActions;
  readonly onPick: (dialog: Dialog) => void;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const items: MenuProps['items'] = [
    actions.edit && { key: 'edit', label: t('common.actions.edit') },
    actions.reassign && { key: 'reassign', label: t('cases.file.actions.reassign') },
    actions.changeStatus && { key: 'status', label: t('cases.file.actions.changeStatus') },
    actions.archive && { key: 'archive', label: t('cases.file.actions.archive') },
    actions.delete && { type: 'divider' as const },
    actions.delete && { key: 'delete', label: t('common.actions.delete'), danger: true },
  ].filter((item) => item !== false);
  if (items.length === 0) return null;
  return (
    <Dropdown
      trigger={['click']}
      menu={{
        items,
        onClick: ({ key }) =>
          // Reassign, status and archive arrive with the file lifecycle story.
          onPick(key === 'edit' ? 'edit' : key === 'delete' ? 'delete' : 'comingSoon'),
      }}
    >
      <Button
        icon={<MoreOutlined />}
        aria-label={t('cases.file.actions.more')}
        data-testid="case-actions"
      />
    </Dropdown>
  );
}

function Header({
  file,
  actions,
  onPick,
}: {
  readonly file: Case;
  readonly actions: FileActions;
  readonly onPick: (dialog: Dialog) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  return (
    <PageHeader
      // Back to wherever the user came from (the list keeps its filters in the URL), else the list.
      onBack={() => void (location.key === 'default' ? navigate('/cases') : navigate(-1))}
      title={
        <span data-testid="case-heading">
          <Ltr>{file.fileNumber}</Ltr> • <Bdi>{file.title}</Bdi>
        </span>
      }
      subtitle={
        <Flex gap={8} align="center" wrap component="span">
          <FileStatusTag status={file.status} />
          <PriorityTag priority={file.priority} />
          {file.isConfidential ? (
            <Tag icon={<LockOutlined aria-hidden />}>{t('cases.list.confidential')}</Tag>
          ) : null}
          <Typography.Text type="secondary">
            {t('cases.file.responsible')} <Bdi>{file.responsibleLawyer.fullName}</Bdi>
          </Typography.Text>
        </Flex>
      }
      extra={
        <>
          {actions.edit ? (
            <Button icon={<EditOutlined />} onClick={() => onPick('edit')} data-testid="case-edit">
              {t('common.actions.edit')}
            </Button>
          ) : null}
          <ActionsMenu actions={actions} onPick={onPick} />
        </>
      }
    />
  );
}

/** A tab whose story has not shipped yet. */
function ComingSoonTab(): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <EmptyState title={t('shell.comingSoon.title')} description={t('shell.comingSoon.body')} />
  );
}

function FileView({ file }: { readonly file: Case }): React.JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const { notify } = useApiErrorHandler();
  const navigate = useNavigate();
  const user = useSession((state) => state.user);
  const [params, setParams] = useSearchParams();
  const [dialog, setDialog] = useState<Dialog>(null);
  const remove = useDeleteCase(file.id);

  const tabs = visibleTabs((permission) => user?.permissions.includes(permission) ?? false);
  const tab = readTab(params, tabs);
  // Inside the shell a user is always signed in; without one nothing is offered.
  const actions = fileActions(file, user ?? { id: '', role: 'TRAINEE', permissions: [] });

  const selectTab = (key: string) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (key === 'details') next.delete('tab');
      else next.set('tab', key);
      return next;
    });

  const confirmDelete = () =>
    remove.mutate(undefined, {
      onSuccess: () => {
        void message.success(t('cases.file.deleted'));
        void navigate('/cases', { replace: true });
      },
      onError: (error) => {
        setDialog(null);
        notify(error);
      },
    });

  return (
    <section data-testid="page-case">
      <Header file={file} actions={actions} onPick={setDialog} />
      <Flex vertical gap={16}>
        {file.status === 'ARCHIVED' ? (
          <Alert
            type="info"
            showIcon
            title={t('cases.file.archivedBanner')}
            data-testid="case-archived-banner"
          />
        ) : null}
        <Tabs
          activeKey={tab}
          onChange={selectTab}
          items={tabs.map((key: FileTab) => ({
            key,
            label: <span data-testid={`tab-${key}`}>{t(`cases.file.tabs.${key}`)}</span>,
            children: key === 'details' ? <CaseDetailsTab file={file} /> : <ComingSoonTab />,
          }))}
        />
      </Flex>
      {actions.edit ? (
        <EditCaseDrawer
          file={file}
          actions={actions}
          open={dialog === 'edit'}
          onClose={() => setDialog(null)}
        />
      ) : null}
      <ConfirmModal
        open={dialog === 'delete'}
        danger
        loading={remove.isPending}
        title={t('cases.file.delete.title')}
        confirmText={t('common.actions.delete')}
        onConfirm={confirmDelete}
        onCancel={() => setDialog(null)}
      >
        {t('cases.file.delete.body', { number: file.fileNumber })}
      </ConfirmModal>
      <Modal
        open={dialog === 'comingSoon'}
        onCancel={() => setDialog(null)}
        footer={null}
        title={t('shell.comingSoon.title')}
        data-testid="case-coming-soon"
      >
        {t('shell.comingSoon.body')}
      </Modal>
    </section>
  );
}

/**
 * `/cases/:id?tab=` (frontend.md#legal-file-page): header with the file's actions, tabs kept in the URL, the Details tab;
 * a file the user cannot see is the 404 page (RES-001, D-019).
 */
export function CasePage(): React.JSX.Element {
  const { id = '' } = useParams();
  const file = useCase(id);
  const { referenceOf } = useApiErrorHandler();

  if (file.data) {
    return <FileView file={file.data} />;
  }
  if (file.isError) {
    const code = isApiError(file.error) ? file.error.code : undefined;
    if (code === 'RES-001') return <NotFoundPage />;
    return (
      <div data-testid="case-error">
        <ErrorState
          code={code !== undefined && isErrorCode(code) ? code : undefined}
          requestId={referenceOf(file.error)}
          onRetry={() => void file.refetch()}
        />
      </div>
    );
  }
  return <LoadingSkeleton rows={8} />;
}
