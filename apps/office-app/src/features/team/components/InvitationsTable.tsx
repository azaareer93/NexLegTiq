import type { Invitation } from '@nexlegtiq/shared-contracts';
import {
  Bdi,
  ConfirmModal,
  ErrorState,
  Ltr,
  StatusTag,
  useApiErrorHandler,
  useFormat,
} from '@nexlegtiq/shared-ui';
import { isolateLtr } from '@nexlegtiq/shared-utils';
import { App, Button, Flex, Table, Typography } from 'antd';
import type { TableProps } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useInvitations, useResendInvitation, useRevokeInvitation } from '../api/use-team';

/** Pending invitations of the office (D-134): resend renews the 7-day link, revoke frees the seat. */
export function InvitationsTable(): React.JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const { notify } = useApiErrorHandler();
  const invitations = useInvitations();
  const revoke = useRevokeInvitation();
  const [revoking, setRevoking] = useState<Invitation | null>(null);
  const columns = useColumns(setRevoking);

  return (
    <Flex vertical gap={8} component="section" aria-labelledby="invitations-title">
      <Typography.Title level={2} id="invitations-title" style={{ marginBlock: 0 }}>
        {t('team.invitations.title')}
      </Typography.Title>
      {invitations.isError ? (
        <ErrorState onRetry={() => void invitations.refetch()} />
      ) : (
        <Table<Invitation>
          data-testid="invitations-table"
          rowKey="id"
          columns={columns}
          dataSource={invitations.data ?? []}
          loading={invitations.isPending}
          pagination={false}
          scroll={{ x: 'max-content' }}
          locale={{ emptyText: t('team.invitations.empty') }}
        />
      )}
      <ConfirmModal
        open={revoking !== null}
        danger
        title={t('team.invitations.revokeTitle')}
        confirmText={t('team.invitations.revoke')}
        loading={revoke.isPending}
        onCancel={() => setRevoking(null)}
        onConfirm={() =>
          revoking &&
          revoke.mutate(revoking.id, {
            onSuccess: () => void message.success(t('team.invitations.revoked')),
            onError: (error) => notify(error),
            onSettled: () => setRevoking(null),
          })
        }
      >
        {revoking ? t('team.invitations.revokeBody', { email: isolateLtr(revoking.email) }) : null}
      </ConfirmModal>
    </Flex>
  );
}

function useColumns(onRevoke: (row: Invitation) => void): TableProps<Invitation>['columns'] {
  const { t } = useTranslation();
  const format = useFormat();
  return [
    {
      key: 'email',
      title: t('team.columns.email'),
      render: (_, row) => (
        <Flex vertical>
          <Ltr>{row.email}</Ltr>
          {row.fullName ? (
            <Typography.Text type="secondary">
              <Bdi>{row.fullName}</Bdi>
            </Typography.Text>
          ) : null}
        </Flex>
      ),
    },
    { key: 'role', title: t('team.columns.role'), render: (_, row) => t(`enums.role.${row.role}`) },
    {
      key: 'invitedBy',
      title: t('team.invitations.invitedBy'),
      render: (_, row) => <Bdi>{row.invitedBy.fullName}</Bdi>,
    },
    {
      key: 'status',
      title: t('team.columns.status'),
      render: (_, row) => (
        <StatusTag tone={row.status === 'PENDING' ? 'info' : 'warning'}>
          {t(`team.invitations.status.${row.status}`)}
        </StatusTag>
      ),
    },
    {
      key: 'expires',
      title: t('team.invitations.expires'),
      render: (_, row) => (
        <time dateTime={row.expiresAt} title={format.dateTime(row.expiresAt)}>
          {format.relative(row.expiresAt)}
        </time>
      ),
    },
    {
      key: 'actions',
      title: t('team.columns.actions'),
      render: (_, row) => <InvitationActions invitation={row} onRevoke={onRevoke} />,
    },
  ];
}

function InvitationActions({
  invitation,
  onRevoke,
}: {
  invitation: Invitation;
  onRevoke: (row: Invitation) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const { notify } = useApiErrorHandler();
  const resend = useResendInvitation();
  const email = isolateLtr(invitation.email);
  return (
    <Flex gap={8}>
      <Button
        aria-label={t('team.invitations.resendOf', { email })}
        loading={resend.isPending}
        onClick={() =>
          resend.mutate(invitation.id, {
            onSuccess: () => void message.success(t('team.invitations.resent')),
            onError: (error) => notify(error),
          })
        }
        data-testid={`invitation-resend-${invitation.id}`}
      >
        {t('team.invitations.resend')}
      </Button>
      <Button
        danger
        aria-label={t('team.invitations.revokeOf', { email })}
        onClick={() => onRevoke(invitation)}
        data-testid={`invitation-revoke-${invitation.id}`}
      >
        {t('team.invitations.revoke')}
      </Button>
    </Flex>
  );
}
