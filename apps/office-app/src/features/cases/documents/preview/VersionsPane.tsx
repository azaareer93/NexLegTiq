import { DownloadOutlined, UploadOutlined } from '@ant-design/icons';
import type { Document, DocumentVersion } from '@nexlegtiq/shared-contracts';
import { isErrorCode } from '@nexlegtiq/shared-types';
import {
  Bdi,
  ErrorState,
  LoadingSkeleton,
  useApiErrorHandler,
  useFormat,
} from '@nexlegtiq/shared-ui';
import {
  App,
  Button,
  Card,
  Flex,
  Input,
  List,
  Progress,
  Tag,
  Tooltip,
  Typography,
  Upload,
} from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { openDownload } from './open-download';
import { useDocumentVersions, useDownloadDocument, useUploadVersion } from './use-document-preview';
import { ACCEPT_ATTRIBUTE, MAX_UPLOAD_MB, uploadProblem } from '../document-upload';
import { useSize } from '../DocumentsTable';

/** "Upload a new version": one file and an optional note; the API scans it before it can be opened (D-126). */
function NewVersion({
  fileId,
  documentId,
}: {
  readonly fileId: string;
  readonly documentId: string;
}) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const { notify } = useApiErrorHandler();
  const upload = useUploadVersion(fileId, documentId);
  const [file, setFile] = useState<File | null>(null);
  const [note, setNote] = useState('');
  const [progress, setProgress] = useState(0);
  const problem = file ? uploadProblem(file) : null;
  const submit = () => {
    if (!file || problem) return;
    upload.mutate(
      {
        input: { file, filename: file.name, ...(note.trim() ? { changeNote: note.trim() } : {}) },
        onProgress: setProgress,
      },
      {
        onSuccess: () => {
          void message.success(t('documents.preview.versionUploaded'));
          setFile(null);
          setNote('');
          setProgress(0);
        },
        onError: notify,
      },
    );
  };
  return (
    <Card size="small" title={t('documents.preview.newVersion')}>
      <Flex vertical gap={12}>
        <Upload
          accept={ACCEPT_ATTRIBUTE}
          maxCount={1}
          beforeUpload={(picked) => {
            setFile(picked);
            return false;
          }}
          onRemove={() => setFile(null)}
          fileList={file ? [{ uid: 'version', name: file.name }] : []}
        >
          <Button icon={<UploadOutlined />} data-testid="document-version-pick">
            {t('documents.preview.pickFile')}
          </Button>
        </Upload>
        {problem ? (
          <Typography.Text type="danger" role="alert">
            {t(`documents.upload.problem.${problem}`, { max: MAX_UPLOAD_MB })}
          </Typography.Text>
        ) : null}
        <Input.TextArea
          value={note}
          onChange={(event) => setNote(event.target.value)}
          maxLength={500}
          autoSize={{ minRows: 2, maxRows: 4 }}
          placeholder={t('documents.preview.changeNote')}
          aria-label={t('documents.preview.changeNote')}
          data-testid="document-version-note"
        />
        {upload.isPending ? <Progress percent={Math.round(progress * 100)} size="small" /> : null}
        <Button
          type="primary"
          onClick={submit}
          disabled={!file || problem !== null}
          loading={upload.isPending}
          data-testid="document-version-submit"
        >
          {t('documents.preview.uploadVersion')}
        </Button>
      </Flex>
    </Card>
  );
}

function VersionItem({
  version,
  current,
  documentId,
}: {
  readonly version: DocumentVersion;
  readonly current: boolean;
  readonly documentId: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  const format = useFormat();
  const size = useSize();
  const { notify } = useApiErrorHandler();
  const download = useDownloadDocument();
  const label = t('documents.preview.downloadVersion', { number: version.versionNumber });
  // Only the current version is downloadable until versions carry their own scan result (D-128).
  const action = current ? (
    <Button
      icon={<DownloadOutlined />}
      loading={download.isPending}
      aria-label={label}
      onClick={() =>
        download.mutate(documentId, { onSuccess: (url) => openDownload(url), onError: notify })
      }
      data-testid={`document-version-download-${version.versionNumber}`}
    />
  ) : (
    <Tooltip title={t('documents.preview.olderUnavailable')}>
      <Button icon={<DownloadOutlined />} aria-label={label} disabled />
    </Tooltip>
  );
  return (
    <List.Item actions={[action]} data-testid={`document-version-${version.versionNumber}`}>
      <List.Item.Meta
        title={
          <Flex gap={8} align="center" wrap>
            <Tag bordered={false}>
              <bdi>{t('documents.list.version', { number: version.versionNumber })}</bdi>
            </Tag>
            <Typography.Text strong>
              <bdi>{version.originalFilename}</bdi>
            </Typography.Text>
            {current ? <Tag color="green">{t('documents.preview.current')}</Tag> : null}
          </Flex>
        }
        description={
          <Flex vertical gap={2}>
            <span>
              <bdi>{version.createdBy.fullName}</bdi>
              {t('documents.preview.separator')}
              <Bdi>{format.dateTime(version.createdAt)}</Bdi>
              {t('documents.preview.separator')}
              {size(version.sizeBytes)}
            </span>
            {version.changeNote ? <bdi>{version.changeNote}</bdi> : null}
          </Flex>
        }
      />
    </List.Item>
  );
}

/** The Versions tab (D-143): every stored upload, newest first, and a new version for those who may replace it. */
export function VersionsPane({
  fileId,
  document,
  canUpload,
}: {
  readonly fileId: string;
  readonly document: Document;
  readonly canUpload: boolean;
}): React.JSX.Element {
  const versions = useDocumentVersions(fileId, document.id);
  if (versions.isError) {
    const { code, requestId } = versions.error as { code?: string; requestId?: string };
    return (
      <ErrorState
        code={code && isErrorCode(code) ? code : undefined}
        requestId={requestId}
        onRetry={() => void versions.refetch()}
      />
    );
  }
  if (!versions.data) return <LoadingSkeleton rows={4} />;
  return (
    <Flex vertical gap={16}>
      <List<DocumentVersion>
        dataSource={versions.data}
        rowKey="versionNumber"
        renderItem={(version) => (
          <VersionItem
            version={version}
            current={version.versionNumber === document.currentVersion}
            documentId={document.id}
          />
        )}
      />
      {canUpload ? <NewVersion fileId={fileId} documentId={document.id} /> : null}
    </Flex>
  );
}
