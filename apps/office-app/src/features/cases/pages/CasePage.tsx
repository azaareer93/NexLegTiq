import { EditOutlined, LockOutlined, MoreOutlined } from '@ant-design/icons';
import { CaseSchema } from '@nexlegtiq/shared-contracts';
import type { Case } from '@nexlegtiq/shared-contracts';
import type { AuthUser } from '@nexlegtiq/shared-contracts';
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
  useCan,
} from '@nexlegtiq/shared-ui';
import { useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Dropdown, Flex, Modal, Tabs, Tag, Typography } from 'antd';
import type { MenuProps } from 'antd';
import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router';

import { useSession } from '../../auth';
import { NotFoundPage } from '../../shell/components/status-pages';
import { caseKeys, useCase, useDeleteCase } from '../api/use-cases';
import { FileStatusTag } from '../components/case-cells';
import { CaseDetailsTab } from '../components/CaseDetailsTab';
import { EditCaseDrawer } from '../components/EditCaseDrawer';
import { fileActions, readTab, visibleTabs } from '../file-page';
import type { FileActions } from '../file-page';

type Dialog = 'edit' | 'delete' | 'comingSoon' | null;
type MenuKey = 'edit' | 'reassign' | 'status' | 'archive' | 'delete';
// Reassign, status and archive arrive with the file lifecycle story.
const DIALOG_OF: Record<MenuKey, Dialog> = {
  edit: 'edit',
  reassign: 'comingSoon',
  status: 'comingSoon',
  archive: 'comingSoon',
  delete: 'delete',
};

/** The ⋮ menu: only the actions the user may take (UI only; the API re-checks, D-051). */
function ActionsMenu({
  actions,
  onPick,
}: {
  readonly actions: FileActions;
  readonly onPick: (dialog: Dialog) => void;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const item = (key: MenuKey, label: string) => ({
    key,
    label: <span data-testid={`case-action-${key}`}>{label}</span>,
  });
  const items: MenuProps['items'] = [
    actions.edit && item('edit', t('common.actions.edit')),
    actions.reassign && item('reassign', t('cases.file.actions.reassign')),
    actions.changeStatus && item('status', t('cases.file.actions.changeStatus')),
    actions.archive && item('archive', t('cases.file.actions.archive')),
    actions.delete && { type: 'divider' as const },
    actions.delete && { ...item('delete', t('common.actions.delete')), danger: true },
  ].filter((entry) => entry !== false);
  if (items.length === 0) return null;
  return (
    <Dropdown
      trigger={['click']}
      menu={{ items, onClick: ({ key }) => onPick(DIALOG_OF[key as MenuKey]) }}
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
      // Back to wherever the user came from (the list keeps its filters in the URL; tab switches replace the entry),
      // else the list.
      onBack={() => void (location.key === 'default' ? navigate('/cases') : navigate(-1))}
      title={
        <Flex component="span" gap={8} wrap data-testid="case-heading">
          <Ltr>{file.fileNumber}</Ltr>
          <span aria-hidden>•</span>
          <Bdi>{file.title}</Bdi>
        </Flex>
      }
      subtitle={
        <Flex gap={8} align="center" wrap component="span">
          <FileStatusTag status={file.status} />
          <PriorityTag priority={file.priority} />
          {file.isConfidential ? (
            <Tag icon={<LockOutlined aria-hidden />}>{t('cases.list.confidential')}</Tag>
          ) : null}
          <Typography.Text type="secondary">
            <Trans
              i18nKey="cases.file.responsible"
              values={{ name: file.responsibleLawyer.fullName }}
              components={{ name: <bdi /> }}
            />
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

function FileView({
  file,
  user,
}: {
  readonly file: Case;
  readonly user: AuthUser;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const { notify } = useApiErrorHandler();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [dialog, setDialog] = useState<Dialog>(null);
  const remove = useDeleteCase(file.id);
  const held = {
    'view:all:invoices': useCan('view:all:invoices'),
    'view:assigned:invoices': useCan('view:assigned:invoices'),
    'use:ai': useCan('use:ai'),
    'view:audit': useCan('view:audit'),
  };

  const tabs = visibleTabs(
    (permission) => permission in held && held[permission as keyof typeof held],
  );
  const tab = readTab(params, tabs);
  const actions = fileActions(file, user);

  // Replace, not push: the back button leaves the file instead of walking through its tabs.
  const selectTab = (key: string) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (key === 'details') next.delete('tab');
        else next.set('tab', key);
        return next;
      },
      { replace: true },
    );

  const confirmDelete = () =>
    remove.mutate(undefined, {
      onSuccess: () => {
        void message.success(t('cases.file.deleted'));
        void navigate('/cases', { replace: true });
        queryClient.removeQueries({ queryKey: caseKeys.detail(file.id) });
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
          items={tabs.map((key) => ({
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
        <Trans
          i18nKey="cases.file.delete.body"
          values={{ number: file.fileNumber }}
          components={{ number: <bdi dir="ltr" /> }}
        />
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
 * a file the user cannot see (or a malformed id) is the 404 page (RES-001, D-019).
 */
export function CasePage(): React.JSX.Element {
  const { id = '' } = useParams();
  const valid = CaseSchema.shape.id.safeParse(id).success;
  const file = useCase(id, valid);
  const user = useSession((state) => state.user);
  const { referenceOf } = useApiErrorHandler();
  const code = isApiError(file.error) ? file.error.code : undefined;

  // Also after a refetch: a file deleted or hidden meanwhile is gone, even with older data in the cache.
  if (!valid || code === 'RES-001') {
    return <NotFoundPage />;
  }
  if (file.data && user) {
    return <FileView file={file.data} user={user} />;
  }
  if (file.isError) {
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
