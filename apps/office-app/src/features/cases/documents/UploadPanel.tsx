import { CloseOutlined, InboxOutlined } from '@ant-design/icons';
import type { Folder } from '@nexlegtiq/shared-contracts';
import { DOCUMENT_TYPES } from '@nexlegtiq/shared-types';
import type { DocumentType } from '@nexlegtiq/shared-types';
import { useApiErrorHandler } from '@nexlegtiq/shared-ui';
import { isolate } from '@nexlegtiq/shared-utils';
import { App, Button, Flex, Form, List, Modal, Progress, Select, Typography, Upload } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ACCEPT_ATTRIBUTE, newItem } from './document-upload';
import type { UploadItem } from './document-upload';
import { useSize } from './DocumentsTable';
import { useFolderName } from './FolderTree';
import { useUploadDocument } from './use-documents';

let sequence = 0;
const nextKey = () => {
  sequence += 1;
  return `upload-${sequence}`;
};

/**
 * Upload panel of the Documents tab (D-133): drag or pick several files, checked here for type and size before anything
 * is sent (the API sniffs the bytes again), one document type and folder for the batch, uploaded one after the other with
 * their own progress. A file's idempotency key is made once, so retrying it never creates a second document.
 */
export function UploadPanel({
  open,
  fileId,
  folders,
  defaultFolderId,
  onClose,
}: {
  readonly open: boolean;
  readonly fileId: string;
  readonly folders: readonly Folder[];
  readonly defaultFolderId: string | null;
  readonly onClose: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const { messageOf } = useApiErrorHandler();
  const folderName = useFolderName();
  const size = useSize();
  const upload = useUploadDocument(fileId);
  const [items, setItems] = useState<UploadItem[]>([]);
  const [documentType, setDocumentType] = useState<DocumentType>('OTHER');
  const [folderId, setFolderId] = useState<string | null>(defaultFolderId);
  const [running, setRunning] = useState(false);
  const keys = useState(() => new Map<string, string>())[0];

  const patch = (key: string, change: Partial<UploadItem>) =>
    setItems((list) => list.map((item) => (item.key === key ? { ...item, ...change } : item)));
  const ready = items.filter((item) => item.state === 'waiting' || item.state === 'error');

  const start = async () => {
    setRunning(true);
    let done = 0;
    for (const item of ready) {
      patch(item.key, { state: 'uploading', progress: 0 });
      const idempotencyKey = keys.get(item.key) ?? crypto.randomUUID();
      keys.set(item.key, idempotencyKey);
      try {
        await upload.mutateAsync({
          input: {
            fileId,
            file: item.file,
            filename: item.file.name,
            documentType,
            ...(folderId ? { folderId } : {}),
          },
          onProgress: (progress) => patch(item.key, { progress }),
          idempotencyKey,
        });
        patch(item.key, { state: 'done', progress: 1 });
        done += 1;
      } catch (error) {
        patch(item.key, {
          state: 'error',
          errorCode: (error as { code?: string }).code ?? 'SYS-001',
        });
      }
    }
    setRunning(false);
    if (done > 0) void message.success(t('documents.upload.finished', { count: done }));
  };

  const close = () => {
    if (running) return;
    setItems([]);
    onClose();
  };

  return (
    <Modal
      open={open}
      title={t('documents.upload.title')}
      onCancel={close}
      destroyOnHidden
      width={640}
      data-testid="upload-panel"
      footer={
        <Flex justify="end" gap={8}>
          <Button onClick={close} disabled={running}>
            {t('documents.upload.close')}
          </Button>
          <Button
            type="primary"
            loading={running}
            disabled={ready.length === 0}
            onClick={() => void start()}
            data-testid="upload-start"
          >
            {t('documents.upload.start', { count: ready.length })}
          </Button>
        </Flex>
      }
    >
      <Flex vertical gap={12}>
        <Upload.Dragger
          multiple
          accept={ACCEPT_ATTRIBUTE}
          showUploadList={false}
          disabled={running}
          // Nothing is sent here: files are queued and uploaded with the chosen type and folder.
          beforeUpload={(file) => {
            setItems((list) => [...list, newItem(file, nextKey())]);
            return false;
          }}
          data-testid="upload-dragger"
        >
          <p className="ant-upload-drag-icon">
            <InboxOutlined />
          </p>
          <p className="ant-upload-text">{t('documents.upload.drop')}</p>
          <p className="ant-upload-hint">{t('documents.upload.hint')}</p>
        </Upload.Dragger>
        <Form layout="vertical">
          <Flex gap={12} wrap>
            <Form.Item label={t('documents.upload.type')} style={{ flex: 1, minWidth: 200 }}>
              <Select<DocumentType>
                value={documentType}
                onChange={setDocumentType}
                disabled={running}
                options={DOCUMENT_TYPES.map((type) => ({
                  value: type,
                  label: t(`enums.documentType.${type}`),
                }))}
                data-testid="upload-type"
              />
            </Form.Item>
            <Form.Item label={t('documents.upload.folder')} style={{ flex: 1, minWidth: 200 }}>
              <Select<string>
                value={folderId ?? 'root'}
                onChange={(value) => setFolderId(value === 'root' ? null : value)}
                disabled={running}
                options={[
                  { value: 'root', label: t('documents.folders.root') },
                  ...folders.map((folder) => ({ value: folder.id, label: folderName(folder) })),
                ]}
                data-testid="upload-folder"
              />
            </Form.Item>
          </Flex>
        </Form>
        {items.length > 0 ? (
          <List
            size="small"
            dataSource={items}
            renderItem={(item) => (
              <List.Item
                data-testid={`upload-item-${item.key}`}
                actions={
                  item.state === 'uploading' || item.state === 'done'
                    ? []
                    : [
                        <Button
                          key="remove"
                          type="text"
                          size="small"
                          icon={<CloseOutlined />}
                          aria-label={t('documents.upload.remove', {
                            name: isolate(item.file.name),
                          })}
                          onClick={() =>
                            setItems((list) => list.filter((other) => other.key !== item.key))
                          }
                        />,
                      ]
                }
              >
                <Flex vertical gap={2} style={{ flex: 1, minWidth: 0 }}>
                  <Flex justify="space-between" gap={8}>
                    <Typography.Text ellipsis>
                      <bdi>{item.file.name}</bdi>
                    </Typography.Text>
                    <Typography.Text type="secondary">{size(item.file.size)}</Typography.Text>
                  </Flex>
                  <ItemState
                    item={item}
                    errorText={item.errorCode ? messageOf({ code: item.errorCode }) : ''}
                  />
                </Flex>
              </List.Item>
            )}
          />
        ) : null}
      </Flex>
    </Modal>
  );
}

function ItemState({
  item,
  errorText,
}: {
  readonly item: UploadItem;
  readonly errorText: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  if (item.state === 'refused') {
    return (
      <Typography.Text type="danger">
        {t(`documents.upload.problem.${item.problem ?? 'type'}`)}
      </Typography.Text>
    );
  }
  if (item.state === 'uploading') {
    return (
      <Progress
        percent={Math.round(item.progress * 100)}
        size="small"
        aria-label={t('documents.upload.uploading')}
      />
    );
  }
  if (item.state === 'error') return <Typography.Text type="danger">{errorText}</Typography.Text>;
  return (
    <Typography.Text type={item.state === 'done' ? 'success' : 'secondary'}>
      {t(`documents.upload.${item.state}`)}
    </Typography.Text>
  );
}
