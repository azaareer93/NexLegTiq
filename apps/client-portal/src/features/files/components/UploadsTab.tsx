import { UploadOutlined } from '@ant-design/icons';
import { MAX_UPLOAD_BYTES } from '@nexlegtiq/shared-contracts';
import type { ClientUploadStatus } from '@nexlegtiq/shared-types';
import {
  Bdi,
  EmptyState,
  LoadingSkeleton,
  StatusTag,
  useApiErrorHandler,
  useFormat,
} from '@nexlegtiq/shared-ui';
import type { StatusTone } from '@nexlegtiq/shared-ui';
import { isolate } from '@nexlegtiq/shared-utils';
import { App, Button, Card, Flex, Typography, Upload } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useUpload, useUploads } from '../hooks';
import { LoadFailed, useSize } from './ListStates';

/** What the API accepts (D-035, D-187); it sniffs the bytes again, this only saves a doomed upload. */
const ACCEPT = '.pdf,.docx,.doc,.jpg,.jpeg,.png,.tif,.tiff,.xlsx,.csv';
const MAX_MB = MAX_UPLOAD_BYTES / (1024 * 1024);

const TONE: Record<ClientUploadStatus, StatusTone> = {
  SCANNING: 'info',
  PENDING_REVIEW: 'info',
  ACCEPTED: 'success',
  REJECTED: 'error',
  QUARANTINED: 'error',
  FAILED: 'warning',
};

/** Send a document to the office (scanned, then reviewed by a lawyer) and follow what was sent. */
export function UploadsTab({ fileId }: { readonly fileId: string }): React.JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const { notify } = useApiErrorHandler();
  const format = useFormat();
  const size = useSize();
  const uploads = useUploads(fileId);
  const upload = useUpload(fileId);
  const [problem, setProblem] = useState<'size' | 'empty' | null>(null);

  const send = (file: File) => {
    const tooBig = file.size > MAX_UPLOAD_BYTES;
    setProblem(file.size === 0 ? 'empty' : tooBig ? 'size' : null);
    if (file.size === 0 || tooBig) return;
    upload.mutate(
      { file, key: crypto.randomUUID() },
      {
        onSuccess: () =>
          void message.success(t('portal.uploads.sent', { name: isolate(file.name) })),
        onError: notify,
      },
    );
  };

  return (
    <Flex vertical gap={16}>
      <Card size="small">
        <Flex vertical gap={8}>
          <Typography.Text>{t('portal.uploads.intro')}</Typography.Text>
          <Upload
            accept={ACCEPT}
            showUploadList={false}
            beforeUpload={(file) => {
              send(file);
              return false;
            }}
          >
            <Button
              type="primary"
              size="large"
              icon={<UploadOutlined aria-hidden />}
              loading={upload.isPending}
              data-testid="upload-pick"
            >
              {t('portal.uploads.pick')}
            </Button>
          </Upload>
          <Typography.Text type="secondary">
            {t('portal.uploads.hint', { max: MAX_MB })}
          </Typography.Text>
          {problem ? (
            <Typography.Text type="danger" role="alert" data-testid="upload-problem">
              {t(`documents.upload.problem.${problem}`, { max: MAX_MB })}
            </Typography.Text>
          ) : null}
        </Flex>
      </Card>
      {uploads.isError ? (
        <LoadFailed error={uploads.error} onRetry={() => void uploads.refetch()} />
      ) : !uploads.data ? (
        <LoadingSkeleton />
      ) : uploads.data.length === 0 ? (
        <EmptyState title={t('portal.uploads.empty')} />
      ) : (
        <Flex vertical gap={8} data-testid="uploads-list">
          {uploads.data.map((item) => (
            <Card size="small" key={item.id} data-testid={`upload-${item.id}`}>
              <Flex vertical gap={4}>
                <Flex justify="space-between" align="start" gap={8}>
                  <Typography.Text ellipsis>
                    <bdi>{item.name}</bdi>
                  </Typography.Text>
                  <StatusTag tone={TONE[item.status]}>
                    {t(`portal.uploads.status.${item.status}`)}
                  </StatusTag>
                </Flex>
                <Typography.Text type="secondary">
                  <Bdi>{format.dateTime(item.createdAt)}</Bdi>
                  {t('timeline.separator')}
                  <Bdi>{size(item.sizeBytes)}</Bdi>
                </Typography.Text>
                {item.rejectionReason ? (
                  <Typography.Text>
                    {t('portal.uploads.reason', { reason: isolate(item.rejectionReason) })}
                  </Typography.Text>
                ) : null}
              </Flex>
            </Card>
          ))}
        </Flex>
      )}
    </Flex>
  );
}
