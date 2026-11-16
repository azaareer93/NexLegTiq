import type { ClientUpload, Folder } from '@nexlegtiq/shared-contracts';
import { DOCUMENT_TYPES } from '@nexlegtiq/shared-types';
import type { DocumentType } from '@nexlegtiq/shared-types';
import { Bdi, ErrorState, StatusTag, useApiErrorHandler, useFormat } from '@nexlegtiq/shared-ui';
import { isolate } from '@nexlegtiq/shared-utils';
import { App, Button, Card, Flex, Input, List, Modal, Select, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useSize } from './DocumentsTable';
import { useFolderName } from './FolderTree';
import { openDownload } from './preview/open-download';
import {
  useAcceptClientUpload,
  useClientUploads,
  useOpenClientUpload,
  useRejectClientUpload,
} from './use-client-uploads';

const TONE = {
  SCANNING: 'info',
  PENDING_REVIEW: 'warning',
  ACCEPTED: 'success',
  REJECTED: 'error',
  QUARANTINED: 'error',
  FAILED: 'error',
} as const satisfies Record<ClientUpload['status'], 'info' | 'warning' | 'success' | 'error'>;

const REASON_MAX = 500;
/** The server's limit on a document name (OriginalFilenameSchema). */
const NAME_MAX = 255;

function AcceptDialog({
  fileId,
  upload,
  folders,
  onClose,
}: {
  readonly fileId: string;
  readonly upload: ClientUpload;
  readonly folders: readonly Folder[];
  readonly onClose: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const { notify } = useApiErrorHandler();
  const folderName = useFolderName();
  const accept = useAcceptClientUpload(fileId);
  const [documentType, setDocumentType] = useState<DocumentType>('OTHER');
  const [folderId, setFolderId] = useState<string | undefined>();
  const [name, setName] = useState('');
  const save = () =>
    accept.mutate(
      {
        id: upload.id,
        body: {
          documentType,
          ...(folderId ? { folderId } : {}),
          ...(name.trim() ? { name: name.trim() } : {}),
        },
      },
      {
        onSuccess: () => {
          void message.success(t('documents.clientUploads.accepted'));
          onClose();
        },
        onError: (error) => {
          onClose();
          notify(error);
        },
      },
    );
  return (
    <Modal
      open
      title={t('documents.clientUploads.acceptTitle')}
      okText={t('documents.clientUploads.accept')}
      cancelText={t('common.actions.cancel')}
      confirmLoading={accept.isPending}
      onCancel={onClose}
      onOk={save}
      data-testid="client-upload-accept-dialog"
    >
      <Flex vertical gap="small">
        <Select<DocumentType>
          value={documentType}
          onChange={setDocumentType}
          aria-label={t('documents.clientUploads.documentType')}
          options={DOCUMENT_TYPES.map((type) => ({
            value: type,
            label: t(`enums.documentType.${type}`),
          }))}
          data-testid="client-upload-type"
        />
        <Select<string>
          allowClear
          value={folderId}
          onChange={setFolderId}
          placeholder={t('documents.clientUploads.folder')}
          aria-label={t('documents.clientUploads.folder')}
          options={folders.map((folder) => ({ value: folder.id, label: folderName(folder) }))}
          data-testid="client-upload-folder"
        />
        <Input
          value={name}
          maxLength={NAME_MAX}
          onChange={(event) => setName(event.target.value)}
          placeholder={t('documents.clientUploads.name')}
          aria-label={t('documents.clientUploads.name')}
          data-testid="client-upload-name"
        />
      </Flex>
    </Modal>
  );
}

function RejectDialog({
  fileId,
  upload,
  onClose,
}: {
  readonly fileId: string;
  readonly upload: ClientUpload;
  readonly onClose: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const { notify } = useApiErrorHandler();
  const reject = useRejectClientUpload(fileId);
  const [reason, setReason] = useState('');
  const save = () =>
    reject.mutate(
      { id: upload.id, body: { reason: reason.trim() } },
      {
        onSuccess: () => {
          void message.success(t('documents.clientUploads.rejected'));
          onClose();
        },
        onError: (error) => {
          onClose();
          notify(error);
        },
      },
    );
  return (
    <Modal
      open
      title={t('documents.clientUploads.rejectTitle')}
      okText={t('documents.clientUploads.reject')}
      okButtonProps={{ danger: true, disabled: reason.trim() === '' }}
      cancelText={t('common.actions.cancel')}
      confirmLoading={reject.isPending}
      onCancel={onClose}
      onOk={save}
      data-testid="client-upload-reject-dialog"
    >
      <Input.TextArea
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        maxLength={REASON_MAX}
        showCount
        rows={4}
        placeholder={t('documents.clientUploads.reasonLabel')}
        aria-label={t('documents.clientUploads.reasonLabel')}
        data-testid="client-upload-reason"
      />
    </Modal>
  );
}

/** What clients sent through the portal, waiting for a lawyer (MVP-99, D-187). Nothing when there is none. */
export function ClientUploadsCard({
  fileId,
  folders,
  canReview,
}: {
  readonly fileId: string;
  readonly folders: readonly Folder[];
  readonly canReview: boolean;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const format = useFormat();
  const size = useSize();
  const { notify } = useApiErrorHandler();
  const list = useClientUploads(fileId);
  const open = useOpenClientUpload();
  const [dialog, setDialog] = useState<{ kind: 'accept' | 'reject'; upload: ClientUpload } | null>(
    null,
  );
  if (list.isError && !list.data) return <ErrorState onRetry={() => void list.refetch()} />;
  const items = list.data ?? [];
  if (items.length === 0) return null;
  return (
    <Card
      title={t('documents.clientUploads.title')}
      data-testid="client-uploads"
      style={{ marginBlockEnd: 16 }}
    >
      <List
        dataSource={items}
        renderItem={(upload) => (
          <List.Item
            key={upload.id}
            data-testid={`client-upload-${upload.id}`}
            actions={
              upload.status === 'PENDING_REVIEW' && canReview
                ? [
                    <Button
                      key="open"
                      size="small"
                      loading={open.isPending && open.variables === upload.id}
                      onClick={() =>
                        open.mutate(upload.id, {
                          onSuccess: (url) => openDownload(url),
                          onError: notify,
                        })
                      }
                      data-testid={`client-upload-open-${upload.id}`}
                    >
                      {t('documents.clientUploads.open')}
                    </Button>,
                    <Button
                      key="accept"
                      size="small"
                      type="primary"
                      onClick={() => setDialog({ kind: 'accept', upload })}
                      data-testid={`client-upload-accept-${upload.id}`}
                    >
                      {t('documents.clientUploads.accept')}
                    </Button>,
                    <Button
                      key="reject"
                      size="small"
                      danger
                      onClick={() => setDialog({ kind: 'reject', upload })}
                      data-testid={`client-upload-reject-${upload.id}`}
                    >
                      {t('documents.clientUploads.reject')}
                    </Button>,
                  ]
                : undefined
            }
          >
            <List.Item.Meta
              title={
                <Flex gap="small" align="center" wrap>
                  <Typography.Text style={{ overflowWrap: 'anywhere' }}>
                    <Bdi>{upload.name}</Bdi>
                  </Typography.Text>
                  <StatusTag tone={TONE[upload.status]}>
                    {t(`enums.clientUploadStatus.${upload.status}`)}
                  </StatusTag>
                </Flex>
              }
              description={
                <Flex vertical>
                  <span>
                    {t('documents.clientUploads.client')}: <Bdi>{upload.client.displayName}</Bdi>
                    {' · '}
                    {t('documents.clientUploads.sentBy')}: <Bdi>{upload.uploaderName}</Bdi>
                    {' · '}
                    <Bdi>{format.dateTime(upload.createdAt)}</Bdi>
                    {' · '}
                    <Bdi>{size(Number(upload.sizeBytes))}</Bdi>
                  </span>
                  {upload.status === 'REJECTED' && upload.rejectionReason ? (
                    <Typography.Text type="secondary">
                      {t('documents.clientUploads.reason', {
                        reason: isolate(upload.rejectionReason),
                      })}
                    </Typography.Text>
                  ) : null}
                </Flex>
              }
            />
          </List.Item>
        )}
      />
      {dialog?.kind === 'accept' ? (
        <AcceptDialog
          key={dialog.upload.id}
          fileId={fileId}
          upload={dialog.upload}
          folders={folders}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === 'reject' ? (
        <RejectDialog
          key={dialog.upload.id}
          fileId={fileId}
          upload={dialog.upload}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </Card>
  );
}
