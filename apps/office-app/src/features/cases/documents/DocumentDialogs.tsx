import { OriginalFilenameSchema } from '@nexlegtiq/shared-contracts';
import type { Document, Folder } from '@nexlegtiq/shared-contracts';
import { ConfirmModal, useApiErrorHandler } from '@nexlegtiq/shared-ui';
import { isolate } from '@nexlegtiq/shared-utils';
import { App, Modal, Select } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useFolderName } from './FolderTree';
import { NameDialog } from './NameDialog';
import { useDeleteDocument, useUpdateDocument } from './use-documents';

export type DialogKind = 'rename' | 'move' | 'delete';
export type Dialog = { kind: DialogKind; document: Document } | null;

function RenameDocument({
  fileId,
  document,
  onClose,
}: {
  readonly fileId: string;
  readonly document: Document | undefined;
  readonly onClose: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const update = useUpdateDocument(fileId);
  return (
    <NameDialog
      open={document !== undefined}
      title={t('documents.actions.renameTitle')}
      label={t('documents.list.name')}
      initial={document?.name ?? ''}
      okText={t('documents.actions.save')}
      schema={OriginalFilenameSchema}
      onSubmit={async (name) => {
        if (document) await update.mutateAsync({ id: document.id, body: { name } });
        void message.success(t('documents.actions.renamed'));
      }}
      onClose={onClose}
      testId="document-rename-dialog"
    />
  );
}

/** Mounted per opening (keyed by the document): the folder picker starts at the document's folder. */
function MoveDocument({
  fileId,
  document,
  folders,
  onClose,
}: {
  readonly fileId: string;
  readonly document: Document;
  readonly folders: readonly Folder[];
  readonly onClose: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const { notify } = useApiErrorHandler();
  const folderName = useFolderName();
  const update = useUpdateDocument(fileId);
  const [target, setTarget] = useState<string | null>(document.folderId);
  const save = () =>
    update.mutate(
      { id: document.id, body: { folderId: target } },
      {
        onSuccess: () => {
          void message.success(t('documents.actions.moved'));
          onClose();
        },
        onError: notify,
      },
    );
  return (
    <Modal
      open
      title={t('documents.actions.moveTitle')}
      okText={t('documents.actions.save')}
      cancelText={t('common.actions.cancel')}
      confirmLoading={update.isPending}
      onCancel={onClose}
      onOk={save}
      data-testid="document-move-dialog"
    >
      <Select
        style={{ width: '100%' }}
        value={target ?? 'root'}
        onChange={(value: string) => setTarget(value === 'root' ? null : value)}
        aria-label={t('documents.upload.folder')}
        options={[
          { value: 'root', label: t('documents.folders.root') },
          ...folders.map((folder) => ({ value: folder.id, label: folderName(folder) })),
        ]}
        data-testid="document-move-select"
      />
    </Modal>
  );
}

function DeleteDocument({
  fileId,
  document,
  onClose,
}: {
  readonly fileId: string;
  readonly document: Document | undefined;
  readonly onClose: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const { notify } = useApiErrorHandler();
  const remove = useDeleteDocument(fileId);
  const confirm = () => {
    if (!document) return;
    remove.mutate(document.id, {
      onSuccess: () => {
        void message.success(t('documents.actions.deleted'));
        onClose();
      },
      onError: (error) => {
        onClose();
        notify(error);
      },
    });
  };
  return (
    <ConfirmModal
      open={document !== undefined}
      danger
      title={t('documents.actions.deleteTitle')}
      confirmText={t('documents.actions.delete')}
      loading={remove.isPending}
      onCancel={onClose}
      onConfirm={confirm}
    >
      {t('documents.actions.deleteBody', { name: isolate(document?.name ?? '') })}
    </ConfirmModal>
  );
}

/** Rename, move and delete dialogs of one document. */
export function DocumentDialogs({
  fileId,
  dialog,
  folders,
  onClose,
}: {
  readonly fileId: string;
  readonly dialog: Dialog;
  readonly folders: readonly Folder[];
  readonly onClose: () => void;
}): React.JSX.Element {
  const of = (kind: DialogKind) => (dialog?.kind === kind ? dialog.document : undefined);
  const moving = of('move');
  return (
    <>
      <RenameDocument fileId={fileId} document={of('rename')} onClose={onClose} />
      {moving ? (
        <MoveDocument
          key={moving.id}
          fileId={fileId}
          document={moving}
          folders={folders}
          onClose={onClose}
        />
      ) : null}
      <DeleteDocument fileId={fileId} document={of('delete')} onClose={onClose} />
    </>
  );
}
