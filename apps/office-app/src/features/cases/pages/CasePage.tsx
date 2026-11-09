import { EditOutlined, LockOutlined, MoreOutlined } from '@ant-design/icons';
import { CaseSchema } from '@nexlegtiq/shared-contracts';
import type { Case } from '@nexlegtiq/shared-contracts';
import type { AuthUser } from '@nexlegtiq/shared-contracts';
import { isErrorCode } from '@nexlegtiq/shared-types';
import {
  Bdi,
  ConfirmModal,
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
import { Alert, App, Button, Dropdown, Flex, Tabs, Tag, Typography } from 'antd';
import type { MenuProps } from 'antd';
import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router';

import { useSession } from '../../auth';
import { NotFoundPage } from '../../shell/components/status-pages';
import { TasksView } from '../../tasks';
import { caseKeys, useCase, useDeleteCase } from '../api/use-cases';
import { FileStatusTag } from '../components/case-cells';
import { CaseDetailsTab } from '../components/CaseDetailsTab';
import { ComingSoonTab } from '../components/ComingSoonTab';
import { EditCaseDrawer } from '../components/EditCaseDrawer';
import { LifecycleDialogs } from '../components/LifecycleDialogs';
import type { LifecycleDialog } from '../components/LifecycleDialogs';
import { DocumentsTab } from '../documents/DocumentsTab';
import { fileActions, isAssigned, readTab, visibleTabs } from '../file-page';
import type { FileActions } from '../file-page';
import { NotesTab } from '../notes/NotesTab';
import { ConflictBanner } from '../parties/ConflictBanner';
import { PartiesTab } from '../parties/PartiesTab';
import { useHearingShortcut, useSessionRights } from '../sessions/session-rights';
import { SessionDrawer } from '../sessions/SessionDrawer';
import { SessionsTab } from '../sessions/SessionsTab';
import { TimelineTab } from '../timeline/TimelineTab';

type MenuKey = 'edit' | LifecycleDialog | 'delete';
type Dialog = MenuKey | null;

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
    actions.close && item('close', t('cases.file.actions.close')),
    actions.reopen && item('reopen', t('cases.file.actions.reopen')),
    actions.archive && item('archive', t('cases.file.actions.archive')),
    actions.delete && { type: 'divider' as const },
    actions.delete && { ...item('delete', t('common.actions.delete')), danger: true },
  ].filter((entry) => entry !== false);
  if (items.length === 0) return null;
  return (
    <Dropdown trigger={['click']} menu={{ items, onClick: ({ key }) => onPick(key as MenuKey) }}>
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
  // The hearing drawer: a hearing's id, null for a new one, undefined while closed.
  const [hearing, setHearing] = useState<string | null | undefined>(undefined);
  const sessionRights = useSessionRights(file, user.id);
  useHearingShortcut(sessionRights.create && dialog === null && hearing === undefined, () =>
    setHearing(null),
  );
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

  const tabContent = (key: string) => {
    if (key === 'details') {
      return <CaseDetailsTab file={file} actions={actions} onOpenHearing={setHearing} />;
    }
    if (key === 'documents') {
      return <DocumentsTab fileId={file.id} archived={file.status === 'ARCHIVED'} />;
    }
    if (key === 'tasks') {
      return <TasksView scope={{ fileId: file.id }} readOnly={file.status === 'ARCHIVED'} />;
    }
    if (key === 'parties') return <PartiesTab fileId={file.id} canEdit={actions.edit} />;
    if (key === 'sessions') {
      return <SessionsTab fileId={file.id} canCreate={sessionRights.create} onOpen={setHearing} />;
    }
    if (key === 'timeline') {
      return <TimelineTab fileId={file.id} onOpenHearing={setHearing} onOpenTab={selectTab} />;
    }
    if (key === 'notes') {
      return (
        <NotesTab
          fileId={file.id}
          canWrite={actions.edit}
          canConfidential={user.role === 'OFFICE_MANAGER' || isAssigned(file, user.id)}
          readOnly={file.status === 'ARCHIVED'}
        />
      );
    }
    return <ComingSoonTab />;
  };

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
        <ConflictBanner fileId={file.id} canResolve={actions.edit} />
        <Tabs
          activeKey={tab}
          onChange={selectTab}
          items={tabs.map((key) => ({
            key,
            label: <span data-testid={`tab-${key}`}>{t(`cases.file.tabs.${key}`)}</span>,
            children: tabContent(key),
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
      <SessionDrawer
        file={file}
        sessionId={hearing ?? null}
        open={hearing !== undefined}
        rights={sessionRights}
        onClose={() => setHearing(undefined)}
      />
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
      <LifecycleDialogs
        file={file}
        dialog={dialog === 'edit' || dialog === 'delete' ? null : dialog}
        onClose={() => setDialog(null)}
      />
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
