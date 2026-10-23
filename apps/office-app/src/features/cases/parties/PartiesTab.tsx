import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import type { AddFilePartyResult, Conflict, FileParty } from '@nexlegtiq/shared-contracts';
import { PARTY_TYPES } from '@nexlegtiq/shared-types';
import type { PartyType } from '@nexlegtiq/shared-types';
import {
  Bdi,
  ConfirmModal,
  EmptyState,
  ErrorState,
  LoadingSkeleton,
  Ltr,
  useApiErrorHandler,
} from '@nexlegtiq/shared-ui';
import { isolate, isolateLtr } from '@nexlegtiq/shared-utils';
import { App, Button, Card, Flex, List, Tag, Typography } from 'antd';
import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { AddPartyModal } from './AddPartyModal';
import { ConflictsModal } from './ConflictsModal';
import { EditRoleModal } from './EditRoleModal';
import { useFileParties, useRemoveParty } from './use-parties';

/** The file's parties by role, in the order of `PARTY_TYPES` (plaintiffs first); empty roles are left out. */
export function groupByRole(parties: readonly FileParty[]): [PartyType, FileParty[]][] {
  return PARTY_TYPES.map((type): [PartyType, FileParty[]] => [
    type,
    parties.filter((row) => row.partyType === type),
  ]).filter(([, rows]) => rows.length > 0);
}

/** Contacts, identifiers (decrypted for readers of the file, D-135) and the representative. */
function PartyDetails({ party }: { readonly party: FileParty['party'] }): React.JSX.Element {
  const { t } = useTranslation();
  const facts = [
    party.nationalId && t('parties.row.nationalId', { value: isolateLtr(party.nationalId) }),
    party.taxId && t('parties.row.taxId', { value: isolateLtr(party.taxId) }),
    party.legalRepresentative &&
      t('parties.row.representative', { name: isolate(party.legalRepresentative) }),
  ].filter(Boolean);
  return (
    <Flex vertical gap={2}>
      <Flex gap={12} wrap>
        {party.phone ? <Ltr>{party.phone}</Ltr> : null}
        {party.email ? <Ltr>{party.email}</Ltr> : null}
      </Flex>
      {facts.map((fact) => (
        <span key={fact}>{fact}</span>
      ))}
    </Flex>
  );
}

function PartyRow({
  row,
  canEdit,
  onEdit,
  onRemove,
}: {
  readonly row: FileParty;
  readonly canEdit: boolean;
  readonly onEdit: () => void;
  readonly onRemove: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { party } = row;
  const name = isolate(party.name);
  return (
    <List.Item
      data-testid={`party-row-${row.id}`}
      actions={
        canEdit
          ? [
              <Button
                key="edit"
                type="text"
                icon={<EditOutlined />}
                aria-label={t('parties.row.edit', { name })}
                onClick={onEdit}
                data-testid={`party-edit-${row.id}`}
              />,
              <Button
                key="remove"
                type="text"
                danger
                icon={<DeleteOutlined />}
                aria-label={t('parties.row.remove', { name })}
                onClick={onRemove}
                data-testid={`party-remove-${row.id}`}
              />,
            ]
          : []
      }
    >
      {/* Not List.Item.Meta: its title is an <h4>, out of the page's heading order. */}
      <Flex vertical gap={4}>
        <Flex gap={8} wrap align="center">
          <Bdi>{party.name}</Bdi>
          <Tag>{t(party.isIndividual ? 'parties.row.person' : 'parties.row.organisation')}</Tag>
          {row.roleLabel ? (
            <Typography.Text type="secondary">
              <Bdi>{row.roleLabel}</Bdi>
            </Typography.Text>
          ) : null}
        </Flex>
        <PartyDetails party={party} />
      </Flex>
    </List.Item>
  );
}

/** The tab's body: loading, failed, empty, or the parties grouped by role. */
function PartyGroups({
  parties,
  canEdit,
  onEdit,
  onRemove,
}: {
  readonly parties: ReturnType<typeof useFileParties>;
  readonly canEdit: boolean;
  readonly onEdit: (row: FileParty) => void;
  readonly onRemove: (row: FileParty) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { referenceOf } = useApiErrorHandler();
  if (parties.isPending) return <LoadingSkeleton rows={4} />;
  if (parties.isError) {
    return (
      <ErrorState requestId={referenceOf(parties.error)} onRetry={() => void parties.refetch()} />
    );
  }
  if (parties.data.length === 0) {
    return <EmptyState title={t('parties.tab.empty')} description={t('parties.tab.emptyHint')} />;
  }
  return (
    <>
      {groupByRole(parties.data).map(([type, rows]) => (
        <Card
          key={type}
          size="small"
          title={t(`enums.partyType.${type}`)}
          data-testid={`party-group-${type}`}
        >
          <List
            dataSource={rows}
            renderItem={(row) => (
              <PartyRow
                row={row}
                canEdit={canEdit}
                onEdit={() => onEdit(row)}
                onRemove={() => onRemove(row)}
              />
            )}
          />
        </Card>
      ))}
    </>
  );
}

/** Conflicts to show, and the file party whose add raised them (so "cancel" can take it off again). */
interface Raised {
  readonly conflicts: readonly Conflict[];
  readonly addedId?: string;
}

/** `?tab=parties` (MVP-142, D-137): the file's parties grouped by role, add/edit/remove, conflict warnings. */
export function PartiesTab({
  fileId,
  canEdit,
}: {
  readonly fileId: string;
  /** Write access to the file (UI only, the API re-checks; nothing on an archived file, D-052). */
  readonly canEdit: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const { notify } = useApiErrorHandler();
  const parties = useFileParties(fileId);
  const remove = useRemoveParty(fileId);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<FileParty | null>(null);
  const [removing, setRemoving] = useState<FileParty | null>(null);
  const [raised, setRaised] = useState<Raised | null>(null);

  const addedId = raised?.addedId;
  const showConflicts = (result: AddFilePartyResult, addedId?: string) => {
    if (result.conflicts.length > 0) setRaised({ conflicts: result.conflicts, addedId });
  };
  const confirmRemove = () =>
    removing &&
    remove.mutate(removing.id, {
      onSuccess: () => void message.success(t('parties.remove.removed')),
      onError: notify,
      onSettled: () => setRemoving(null),
    });

  return (
    <Flex vertical gap={16} data-testid="case-parties">
      {canEdit ? (
        <Flex justify="end">
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => setAdding(true)}
            data-testid="party-add"
          >
            {t('parties.tab.add')}
          </Button>
        </Flex>
      ) : null}
      <PartyGroups parties={parties} canEdit={canEdit} onEdit={setEditing} onRemove={setRemoving} />
      {/* Mounted per opening: a fresh form, starting on "existing party". */}
      {adding ? (
        <AddPartyModal
          open
          fileId={fileId}
          onClose={() => setAdding(false)}
          onAdded={(result) => {
            setAdding(false);
            void message.success(t('parties.add.added'));
            showConflicts(result, result.fileParty.id);
          }}
        />
      ) : null}
      <EditRoleModal
        fileId={fileId}
        row={editing}
        onClose={() => setEditing(null)}
        onConflicts={showConflicts}
      />
      <ConfirmModal
        open={removing !== null}
        danger
        loading={remove.isPending}
        title={t('parties.remove.title')}
        confirmText={t('parties.remove.confirm')}
        onConfirm={confirmRemove}
        onCancel={() => setRemoving(null)}
      >
        <Trans
          i18nKey="parties.remove.body"
          values={{ name: removing?.party.name ?? '' }}
          components={{ name: <bdi /> }}
        />
      </ConfirmModal>
      <ConflictsModal
        open={raised !== null}
        fileId={fileId}
        conflicts={raised?.conflicts ?? []}
        canResolve={canEdit}
        {...(addedId && {
          onCancelAdd: () => remove.mutateAsync(addedId),
        })}
        onClose={() => setRaised(null)}
      />
    </Flex>
  );
}
