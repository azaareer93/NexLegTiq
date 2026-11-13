import { DeleteOutlined, EditOutlined, FileTextOutlined, PlusOutlined } from '@ant-design/icons';
import type { Witness } from '@nexlegtiq/shared-contracts';
import {
  Bdi,
  ConfirmModal,
  EmptyState,
  ErrorState,
  LoadingSkeleton,
  Ltr,
  useApiErrorHandler,
} from '@nexlegtiq/shared-ui';
import { isolate } from '@nexlegtiq/shared-utils';
import { App, Button, Card, Flex, List, Tag, Typography } from 'antd';
import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { StatementsDrawer } from './StatementsDrawer';
import { useWitnessMutations, useWitnesses } from './use-witnesses';
import { WitnessModal } from './WitnessModal';

function WitnessRow({
  witness,
  canEdit,
  onOpen,
  onEdit,
  onRemove,
}: {
  readonly witness: Witness;
  readonly canEdit: boolean;
  readonly onOpen: () => void;
  readonly onEdit: () => void;
  readonly onRemove: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const name = isolate(witness.fullName);
  const actions = [
    <Button
      key="statements"
      type="link"
      icon={<FileTextOutlined />}
      onClick={onOpen}
      data-testid={`witness-statements-${witness.id}`}
    >
      {t('parties.witnesses.statements', { count: witness.statementCount })}
    </Button>,
    ...(canEdit
      ? [
          <Button
            key="edit"
            type="text"
            icon={<EditOutlined />}
            aria-label={t('parties.witnesses.edit', { name })}
            onClick={onEdit}
            data-testid={`witness-edit-${witness.id}`}
          />,
          <Button
            key="remove"
            type="text"
            danger
            icon={<DeleteOutlined />}
            aria-label={t('parties.witnesses.remove', { name })}
            onClick={onRemove}
            data-testid={`witness-remove-${witness.id}`}
          />,
        ]
      : []),
  ];
  return (
    <List.Item data-testid={`witness-row-${witness.id}`} actions={actions}>
      <Flex vertical gap={2}>
        <Flex gap={8} align="center" wrap>
          <Typography.Text strong>
            <Bdi>{witness.fullName}</Bdi>
          </Typography.Text>
          {witness.isExpert ? <Tag>{t('parties.witnesses.expert')}</Tag> : null}
          {witness.expertiseArea ? <Bdi>{witness.expertiseArea}</Bdi> : null}
        </Flex>
        <Flex gap={12} wrap>
          {witness.phone ? <Ltr>{witness.phone}</Ltr> : null}
          {witness.email ? <Ltr>{witness.email}</Ltr> : null}
        </Flex>
      </Flex>
    </List.Item>
  );
}

/** The file's witnesses and experts with their statements (MVP-143, D-163); internal, never on the portal. */
export function WitnessesSection({
  fileId,
  canEdit,
}: {
  readonly fileId: string;
  /** Write access to the file (UI only, the API re-checks). */
  readonly canEdit: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const { notify } = useApiErrorHandler();
  const witnesses = useWitnesses(fileId);
  const { remove } = useWitnessMutations(fileId);
  // undefined = closed, null = a new witness.
  const [editing, setEditing] = useState<Witness | null | undefined>(undefined);
  const [removing, setRemoving] = useState<Witness | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const open = witnesses.data?.find((witness) => witness.id === openId);

  const body = () => {
    if (witnesses.isPending) return <LoadingSkeleton rows={2} />;
    if (witnesses.isError) return <ErrorState onRetry={() => void witnesses.refetch()} />;
    if (witnesses.data.length === 0) return <EmptyState title={t('parties.witnesses.empty')} />;
    return (
      <List
        dataSource={witnesses.data}
        renderItem={(witness) => (
          <WitnessRow
            witness={witness}
            canEdit={canEdit}
            onOpen={() => setOpenId(witness.id)}
            onEdit={() => setEditing(witness)}
            onRemove={() => setRemoving(witness)}
          />
        )}
      />
    );
  };

  return (
    <Card
      title={t('parties.witnesses.title')}
      data-testid="case-witnesses"
      extra={
        canEdit ? (
          <Button
            icon={<PlusOutlined />}
            onClick={() => setEditing(null)}
            data-testid="witness-add"
          >
            {t('parties.witnesses.add')}
          </Button>
        ) : null
      }
    >
      {body()}
      {editing !== undefined ? (
        <WitnessModal fileId={fileId} witness={editing} onClose={() => setEditing(undefined)} />
      ) : null}
      {open ? (
        <StatementsDrawer
          fileId={fileId}
          witness={open}
          canEdit={canEdit}
          onClose={() => setOpenId(null)}
        />
      ) : null}
      <ConfirmModal
        open={removing !== null}
        danger
        loading={remove.isPending}
        title={t('parties.witnesses.removeTitle')}
        confirmText={t('common.actions.delete')}
        onConfirm={() =>
          removing &&
          remove.mutate(removing.id, {
            onSuccess: () => void message.success(t('parties.witnesses.removed')),
            onError: notify,
            onSettled: () => setRemoving(null),
          })
        }
        onCancel={() => setRemoving(null)}
      >
        <Trans
          i18nKey="parties.witnesses.removeBody"
          values={{ name: removing?.fullName ?? '' }}
          components={{ name: <bdi /> }}
        />
      </ConfirmModal>
    </Card>
  );
}
