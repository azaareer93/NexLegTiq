import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import type { Witness, WitnessStatement } from '@nexlegtiq/shared-contracts';
import {
  ConfirmModal,
  EmptyState,
  ErrorState,
  LoadingSkeleton,
  useApiErrorHandler,
  useFormat,
} from '@nexlegtiq/shared-ui';
import { isolate } from '@nexlegtiq/shared-utils';
import { Button, Card, Drawer, Flex, Tag, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { StatementForm } from './StatementForm';
import { useStatementMutations, useStatements } from './use-witnesses';

function StatementCard({
  statement,
  canEdit,
  onEdit,
  onRemove,
}: {
  readonly statement: WitnessStatement;
  readonly canEdit: boolean;
  readonly onEdit: () => void;
  readonly onRemove: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const format = useFormat();
  const date = format.date(statement.statementDate);
  return (
    <Card size="small" data-testid={`statement-${statement.id}`}>
      <Flex justify="space-between" gap={8} wrap>
        <Flex gap={8} wrap align="center">
          <Typography.Text strong>{date}</Typography.Text>
          {statement.isUnderOath ? <Tag>{t('parties.statements.underOath')}</Tag> : null}
          {statement.session ? (
            <Typography.Text type="secondary">
              {t('parties.statements.atHearing', {
                date: format.dateTime(statement.session.startsAt),
              })}
            </Typography.Text>
          ) : null}
        </Flex>
        {canEdit ? (
          <Flex gap={4}>
            <Button
              type="text"
              icon={<EditOutlined />}
              aria-label={t('parties.statements.edit', { date })}
              onClick={onEdit}
              data-testid={`statement-edit-${statement.id}`}
            />
            <Button
              type="text"
              danger
              icon={<DeleteOutlined />}
              aria-label={t('parties.statements.remove', { date })}
              onClick={onRemove}
              data-testid={`statement-remove-${statement.id}`}
            />
          </Flex>
        ) : null}
      </Flex>
      {/* Plain text as written (never HTML); each paragraph in its own direction. */}
      <Typography.Paragraph
        style={{
          whiteSpace: 'pre-wrap',
          unicodeBidi: 'plaintext',
          textAlign: 'start',
          marginBlock: 8,
        }}
        data-testid="statement-text-view"
      >
        {statement.text}
      </Typography.Paragraph>
      <Typography.Text type="secondary">
        {t('parties.statements.recordedBy', { name: isolate(statement.recordedBy.fullName) })}
      </Typography.Text>
    </Card>
  );
}

/** A witness's statements, newest first, with add/edit/remove for those who may edit the file (D-163). */
export function StatementsDrawer({
  fileId,
  witness,
  canEdit,
  onClose,
}: {
  readonly fileId: string;
  readonly witness: Witness;
  readonly canEdit: boolean;
  readonly onClose: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { notify } = useApiErrorHandler();
  const statements = useStatements(fileId, witness.id);
  const { remove } = useStatementMutations(fileId, witness.id);
  // undefined = no form, null = a new statement.
  const [editing, setEditing] = useState<WitnessStatement | null | undefined>(undefined);
  const [removing, setRemoving] = useState<WitnessStatement | null>(null);

  const list = () => {
    if (statements.isPending) return <LoadingSkeleton rows={3} />;
    if (statements.isError) return <ErrorState onRetry={() => void statements.refetch()} />;
    if (statements.data.length === 0) {
      return <EmptyState title={t('parties.statements.empty')} />;
    }
    return statements.data.map((statement) =>
      editing?.id === statement.id ? (
        <StatementForm
          key={statement.id}
          fileId={fileId}
          witnessId={witness.id}
          statement={statement}
          onDone={() => setEditing(undefined)}
        />
      ) : (
        <StatementCard
          key={statement.id}
          statement={statement}
          canEdit={canEdit}
          onEdit={() => setEditing(statement)}
          onRemove={() => setRemoving(statement)}
        />
      ),
    );
  };

  return (
    <Drawer
      open
      size="large"
      title={t('parties.statements.title', { name: isolate(witness.fullName) })}
      onClose={onClose}
      data-testid="statements-drawer"
    >
      <Flex vertical gap={12}>
        {canEdit && editing === undefined ? (
          <Flex justify="end">
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => setEditing(null)}
              data-testid="statement-add"
            >
              {t('parties.statements.add')}
            </Button>
          </Flex>
        ) : null}
        {editing === null ? (
          <StatementForm
            fileId={fileId}
            witnessId={witness.id}
            statement={null}
            onDone={() => setEditing(undefined)}
          />
        ) : null}
        {list()}
      </Flex>
      <ConfirmModal
        open={removing !== null}
        danger
        loading={remove.isPending}
        title={t('parties.statements.removeTitle')}
        confirmText={t('common.actions.delete')}
        onConfirm={() =>
          removing &&
          remove.mutate(removing.id, { onError: notify, onSettled: () => setRemoving(null) })
        }
        onCancel={() => setRemoving(null)}
      >
        {t('parties.statements.removeBody')}
      </ConfirmModal>
    </Drawer>
  );
}
