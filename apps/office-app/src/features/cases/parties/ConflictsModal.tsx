import { ResolveConflictSchema } from '@nexlegtiq/shared-contracts';
import type { Conflict } from '@nexlegtiq/shared-contracts';
import { useApiErrorHandler } from '@nexlegtiq/shared-ui';
import { App, Button, Form, Input, List, Modal, Typography } from 'antd';
import { Trans, useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { useResolveConflict } from './use-parties';
import { zodRule } from '../../auth/forms';

/** The file on the other side of a conflict seen from `fileId`; null when the reader may not open it (D-135). */
export function otherFileOf(conflict: Conflict, fileId: string): Conflict['file'] {
  if (conflict.file?.id === fileId) return conflict.otherFile;
  if (conflict.otherFile?.id === fileId) return conflict.file;
  return conflict.otherFile;
}

function ConflictLine({
  conflict,
  fileId,
}: {
  readonly conflict: Conflict;
  readonly fileId: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  const other = otherFileOf(conflict, fileId);
  return (
    <List.Item data-testid={`conflict-${conflict.id}`}>
      <Trans
        i18nKey={`parties.conflicts.reason.${conflict.reason}`}
        values={{
          party: conflict.party.name,
          file: other ? other.fileNumber : t('parties.conflicts.hiddenFile'),
        }}
        components={{
          party: <bdi />,
          // A file the reader may open is a link; its number reads left to right (D-092).
          file: other ? <Link to={`/cases/${other.id}`} dir="ltr" /> : <span />,
        }}
      />
    </List.Item>
  );
}

/**
 * Conflicts of interest of a file (W9, D-135): warn, never block. "Proceed with note" records the same note on each
 * one (`PATCH /conflicts/:id/resolve`); right after an add, "cancel" takes the party off the file again.
 */
export function ConflictsModal({
  open,
  fileId,
  conflicts,
  canResolve,
  onCancelAdd,
  onClose,
}: {
  readonly open: boolean;
  readonly fileId: string;
  readonly conflicts: readonly Conflict[];
  readonly canResolve: boolean;
  /** Only right after the add that raised them. */
  readonly onCancelAdd?: () => Promise<unknown>;
  readonly onClose: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const { applyToForm, notify } = useApiErrorHandler();
  const [form] = Form.useForm<{ notes: string }>();
  const resolve = useResolveConflict(fileId);

  const proceed = async () => {
    const values = await form.validateFields().catch(() => null);
    if (!values) return;
    const { notes } = values;
    try {
      // One after the other: a failure stops with the rest still open, and the list refreshes.
      for (const conflict of conflicts) {
        await resolve.mutateAsync({ id: conflict.id, notes: notes.trim() });
      }
      void message.success(t('parties.conflicts.resolved'));
      onClose();
    } catch (error) {
      if (!applyToForm(form, error, ['notes'])) notify(error);
    }
  };
  const cancelAdd = async () => {
    try {
      await onCancelAdd?.();
      onClose();
    } catch (error) {
      notify(error);
    }
  };

  return (
    <Modal
      open={open}
      title={t('parties.conflicts.title')}
      onCancel={onClose}
      destroyOnHidden
      data-testid="conflicts-modal"
      footer={[
        onCancelAdd ? (
          <Button
            key="cancel"
            danger
            onClick={() => void cancelAdd()}
            data-testid="conflicts-cancel-add"
          >
            {t('parties.conflicts.cancelAdd')}
          </Button>
        ) : null,
        <Button key="close" onClick={onClose} data-testid="conflicts-close">
          {t('parties.conflicts.close')}
        </Button>,
        canResolve ? (
          <Button
            key="proceed"
            type="primary"
            loading={resolve.isPending}
            onClick={() => void proceed()}
            data-testid="conflicts-proceed"
          >
            {t('parties.conflicts.proceed')}
          </Button>
        ) : null,
      ]}
    >
      <Typography.Paragraph>{t('parties.conflicts.intro')}</Typography.Paragraph>
      <List
        size="small"
        dataSource={[...conflicts]}
        renderItem={(conflict) => <ConflictLine conflict={conflict} fileId={fileId} />}
      />
      {canResolve ? (
        <Form form={form} layout="vertical" noValidate preserve={false}>
          <Form.Item
            name="notes"
            label={t('parties.conflicts.notes')}
            rules={zodRule(ResolveConflictSchema.shape.notes, (key) => t(key as never))}
          >
            <Input.TextArea rows={3} maxLength={2000} data-testid="conflicts-notes" />
          </Form.Item>
        </Form>
      ) : null}
    </Modal>
  );
}
