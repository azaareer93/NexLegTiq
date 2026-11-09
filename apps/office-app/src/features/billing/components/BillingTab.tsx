import type { TimeEntry } from '@nexlegtiq/shared-contracts';
import { isErrorCode } from '@nexlegtiq/shared-types';
import {
  ConfirmModal,
  EmptyState,
  ErrorState,
  isApiError,
  LoadingSkeleton,
  useApiErrorHandler,
  useCan,
} from '@nexlegtiq/shared-ui';
import { Button, Flex } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { EntriesTable, Totals } from './EntriesTable';
import { EntryModal } from './EntryModal';
import { StartTimerButton } from './StartTimerButton';
import { useTimeEntries, useTimeMutations, useTimeTotals, useTimer } from '../api/use-billing';

/** Log time by hand, or start the timer on this case when none runs. */
function Toolbar({ fileId, onAdd }: { readonly fileId: string; readonly onAdd: () => void }) {
  const { t } = useTranslation();
  const timer = useTimer(true);
  return (
    <Flex gap={8} wrap>
      <Button type="primary" onClick={onAdd} data-testid="entry-add">
        {t('billing.addEntry')}
      </Button>
      {timer.data === null ? (
        <StartTimerButton
          fileId={fileId}
          label={t('billing.timer.startOnFile')}
          testId="tab-timer-start"
        />
      ) : null}
    </Flex>
  );
}

function LoadError({ error, onRetry }: { readonly error: unknown; readonly onRetry: () => void }) {
  const { referenceOf } = useApiErrorHandler();
  const code = isApiError(error) ? error.code : undefined;
  return (
    <ErrorState
      code={code && isErrorCode(code) ? code : undefined}
      requestId={referenceOf(error)}
      onRetry={onRetry}
    />
  );
}

/** Delete after a confirm; invoiced entries never reach it (BIZ-006 would refuse). */
function DeleteEntry({
  entry,
  onClose,
}: {
  readonly entry: TimeEntry | null;
  readonly onClose: () => void;
}) {
  const { t } = useTranslation();
  const { notify } = useApiErrorHandler();
  const { remove } = useTimeMutations();
  return (
    <ConfirmModal
      open={entry !== null}
      danger
      title={t('billing.delete.title')}
      confirmText={t('common.actions.delete')}
      loading={remove.isPending}
      onConfirm={() => entry && remove.mutate(entry.id, { onSettled: onClose, onError: notify })}
      onCancel={onClose}
    >
      {t('billing.delete.body')}
    </ConfirmModal>
  );
}

/** `?tab=billing` (MVP-93, D-152): time entries of the file with their totals; add, edit and delete while it is open. */
export function BillingTab({
  fileId,
  archived,
}: {
  readonly fileId: string;
  readonly archived: boolean;
}) {
  const { t } = useTranslation();
  const mayLog = useCan('log:time');
  const canLog = mayLog && !archived;
  const allInvoices = useCan('view:all:invoices');
  const assignedInvoices = useCan('view:assigned:invoices');
  const [page, setPage] = useState(1);
  const entries = useTimeEntries(fileId, page);
  const totals = useTimeTotals(fileId);
  // null = a new entry; undefined = closed.
  const [editing, setEditing] = useState<TimeEntry | null | undefined>(undefined);
  const [deleting, setDeleting] = useState<TimeEntry | null>(null);

  if (entries.isError)
    return <LoadError error={entries.error} onRetry={() => void entries.refetch()} />;
  if (!entries.data) return <LoadingSkeleton rows={4} />;

  return (
    <Flex vertical gap={16} data-testid="billing-tab">
      {totals.data ? <Totals totals={totals.data} /> : null}
      {canLog ? <Toolbar fileId={fileId} onAdd={() => setEditing(null)} /> : null}
      {entries.data.items.length === 0 ? (
        <EmptyState title={t('billing.empty')} />
      ) : (
        <EntriesTable
          entries={entries.data.items}
          total={entries.data.pagination.total}
          page={page}
          onPage={setPage}
          showMoney={allInvoices || assignedInvoices}
          canLog={canLog}
          onEdit={setEditing}
          onDelete={setDeleting}
        />
      )}
      {editing !== undefined ? (
        <EntryModal fileId={fileId} entry={editing} onClose={() => setEditing(undefined)} />
      ) : null}
      <DeleteEntry entry={deleting} onClose={() => setDeleting(null)} />
    </Flex>
  );
}
