import type { TeamMember } from '@nexlegtiq/shared-contracts';
import { isErrorCode, ROLES } from '@nexlegtiq/shared-types';
import type { Role } from '@nexlegtiq/shared-types';
import {
  Bdi,
  isApiError,
  ErrorState,
  Ltr,
  PageHeader,
  StatusTag,
  useApiErrorHandler,
  useFormat,
} from '@nexlegtiq/shared-ui';
import { isolate } from '@nexlegtiq/shared-utils';
import { App, Button, Flex, Select, Table, Tag } from 'antd';
import type { TableProps } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useSession } from '../../auth';
import { useChangeRole, useReactivate, useTeam } from '../api/use-team';
import { DeactivateModal } from '../components/DeactivateModal';

/**
 * `/team` (`manage:users`, D-091, D-124): the office's people with role, status, open files and last sign-in; the role is
 * changed in place, deactivation goes through the reassignment wizard. Your own row is read-only (no locking yourself out).
 */
export function TeamPage(): React.JSX.Element {
  const { t } = useTranslation();
  const { referenceOf } = useApiErrorHandler();
  const team = useTeam();
  const [leaving, setLeaving] = useState<TeamMember | null>(null);
  const columns = useColumns(setLeaving);
  return (
    <Flex vertical gap={16} component="section" data-testid="page-team">
      <PageHeader title={t('team.title')} />
      {team.isError ? (
        <ErrorState
          code={
            isApiError(team.error) && isErrorCode(team.error.code) ? team.error.code : undefined
          }
          requestId={referenceOf(team.error)}
          onRetry={() => void team.refetch()}
        />
      ) : (
        <Table<TeamMember>
          data-testid="team-table"
          rowKey="id"
          columns={columns}
          dataSource={team.data ?? []}
          loading={team.isPending}
          pagination={false}
          // shortcut: one scrolling table on phones, as the clients list (D-121).
          scroll={{ x: 'max-content' }}
          onRow={(row) =>
            ({ 'data-testid': `team-row-${row.id}` }) as React.HTMLAttributes<HTMLElement>
          }
        />
      )}
      {leaving ? (
        <DeactivateModal member={leaving} team={team.data ?? []} onClose={() => setLeaving(null)} />
      ) : null}
    </Flex>
  );
}

function useColumns(onDeactivate: (member: TeamMember) => void): TableProps<TeamMember>['columns'] {
  const { t } = useTranslation();
  const format = useFormat();
  const me = useSession((state) => state.user?.id);
  return [
    {
      key: 'name',
      title: t('team.columns.name'),
      render: (_, row) => (
        <Flex gap={8} align="center" wrap>
          <Bdi>{row.fullName}</Bdi>
          {row.id === me ? <Tag>{t('team.you')}</Tag> : null}
        </Flex>
      ),
    },
    {
      key: 'email',
      title: t('team.columns.email'),
      render: (_, row) => <Ltr>{row.email}</Ltr>,
    },
    {
      key: 'role',
      title: t('team.columns.role'),
      render: (_, row) => <RoleSelect member={row} readOnly={row.id === me || !row.isActive} />,
    },
    {
      key: 'status',
      title: t('team.columns.status'),
      render: (_, row) =>
        row.isActive ? (
          <StatusTag tone="success">{t('team.status.active')}</StatusTag>
        ) : (
          <StatusTag tone="neutral">{t('team.status.inactive')}</StatusTag>
        ),
    },
    {
      key: 'openFiles',
      title: t('team.columns.openFiles'),
      render: (_, row) => format.number(row.openFiles),
    },
    {
      key: 'lastLogin',
      title: t('team.columns.lastLogin'),
      render: (_, row) =>
        row.lastLoginAt ? (
          <time dateTime={row.lastLoginAt} title={format.dateTime(row.lastLoginAt)}>
            {format.relative(row.lastLoginAt)}
          </time>
        ) : (
          t('team.never')
        ),
    },
    {
      key: 'actions',
      title: t('team.columns.actions'),
      render: (_, row) =>
        row.id === me ? null : <MemberAction member={row} onDeactivate={onDeactivate} />,
    },
  ];
}

/** Who may be a file's responsible lawyer (the API's rule, D-096). */
const LAWYER_ROLES: ReadonlySet<Role> = new Set(['OFFICE_MANAGER', 'SENIOR_LAWYER', 'LAWYER']);

function RoleSelect({
  member,
  readOnly,
}: {
  member: TeamMember;
  readOnly: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const { notify, translateKey } = useApiErrorHandler();
  const change = useChangeRole();
  if (readOnly) return <>{t(`enums.role.${member.role}`)}</>;
  return (
    <Select<Role>
      value={member.role}
      aria-label={t('team.roleOf', { name: isolate(member.fullName) })}
      loading={change.isPending}
      disabled={change.isPending}
      popupMatchSelectWidth={false}
      // A responsible lawyer of open files keeps a lawyer role until the files are reassigned (D-124).
      options={ROLES.map((role) => ({
        value: role,
        label: t(`enums.role.${role}`),
        disabled: member.openFiles > 0 && !LAWYER_ROLES.has(role),
      }))}
      onChange={(role) =>
        change.mutate(
          { id: member.id, role },
          {
            onSuccess: () => void message.success(t('team.roleChanged')),
            // A VAL-001 detail (validation.roleHasOpenFiles) says what to do; anything else is the generic message.
            onError: (error) => {
              const detail = isApiError(error) ? error.details?.[0] : undefined;
              if (detail) void message.error(translateKey(detail.message));
              else notify(error);
            },
          },
        )
      }
      data-testid={`team-role-${member.id}`}
    />
  );
}

function MemberAction({
  member,
  onDeactivate,
}: {
  member: TeamMember;
  onDeactivate: (member: TeamMember) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const { notify } = useApiErrorHandler();
  const reactivate = useReactivate();
  if (member.isActive) {
    return (
      <Button
        danger
        aria-label={t('team.deactivate.title', { name: isolate(member.fullName) })}
        onClick={() => onDeactivate(member)}
        data-testid={`team-deactivate-${member.id}`}
      >
        {t('team.deactivate.action')}
      </Button>
    );
  }
  return (
    <Button
      aria-label={t('team.reactivateTitle', { name: isolate(member.fullName) })}
      loading={reactivate.isPending}
      onClick={() =>
        reactivate.mutate(member.id, {
          onSuccess: () =>
            void message.success(t('team.reactivated', { name: isolate(member.fullName) })),
          onError: (error) => notify(error),
        })
      }
      data-testid={`team-reactivate-${member.id}`}
    >
      {t('team.reactivate')}
    </Button>
  );
}
