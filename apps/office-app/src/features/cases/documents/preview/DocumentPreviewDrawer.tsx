import { DownloadOutlined } from '@ant-design/icons';
import { isErrorCode } from '@nexlegtiq/shared-types';
import { ErrorState, LoadingSkeleton, StatusTag, useApiErrorHandler } from '@nexlegtiq/shared-ui';
import { Button, Drawer, Flex, Tabs } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { openDownload } from './open-download';
import { PreviewPane } from './PreviewPane';
import { TextPane } from './TextPane';
import { useDocumentDetail, useDownloadDocument } from './use-document-preview';
import { VersionsPane } from './VersionsPane';
import { STATUS_TONE } from '../document-upload';

type TabKey = 'preview' | 'text' | 'versions';

/**
 * A document opened from the Documents tab (D-143): preview, extracted text and versions, and a download of the current
 * version. Tabs mount when first shown, so a preview, a text page and a download link (each an audit row, D-128) are
 * asked for only when the user looks at them.
 */
export function DocumentPreviewDrawer({
  fileId,
  documentId,
  canUpload,
  onClose,
}: {
  readonly fileId: string;
  readonly documentId: string;
  readonly canUpload: boolean;
  readonly onClose: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { notify } = useApiErrorHandler();
  const detail = useDocumentDetail(fileId, documentId);
  const download = useDownloadDocument();
  const [tab, setTab] = useState<TabKey>('preview');
  const document = detail.data;
  const body = () => {
    if (detail.isError) {
      const { code, requestId } = detail.error as { code?: string; requestId?: string };
      return (
        <ErrorState
          code={code && isErrorCode(code) ? code : undefined}
          requestId={requestId}
          onRetry={() => void detail.refetch()}
        />
      );
    }
    if (!document) return <LoadingSkeleton rows={6} />;
    return (
      <Tabs
        activeKey={tab}
        onChange={(key) => setTab(key as TabKey)}
        destroyOnHidden={false}
        items={[
          {
            key: 'preview',
            label: t('documents.preview.tabs.preview'),
            children: <PreviewPane document={document} />,
          },
          {
            key: 'text',
            label: t('documents.preview.tabs.text'),
            children: <TextPane fileId={fileId} document={document} />,
          },
          {
            key: 'versions',
            label: t('documents.preview.tabs.versions'),
            children: <VersionsPane fileId={fileId} document={document} canUpload={canUpload} />,
          },
        ]}
      />
    );
  };
  return (
    <Drawer
      open
      onClose={onClose}
      size="large"
      destroyOnHidden
      title={
        document ? (
          <Flex gap={8} align="center" wrap>
            <bdi>{document.name}</bdi>
            <StatusTag tone={STATUS_TONE[document.status]}>
              {t(`enums.documentStatus.${document.status}`)}
            </StatusTag>
          </Flex>
        ) : (
          t('documents.preview.loading')
        )
      }
      extra={
        document ? (
          <Button
            icon={<DownloadOutlined />}
            loading={download.isPending}
            onClick={() =>
              download.mutate(document.id, {
                onSuccess: (url) => openDownload(url),
                onError: notify,
              })
            }
            data-testid="document-download"
          >
            {t('documents.preview.download')}
          </Button>
        ) : null
      }
      data-testid="document-preview-drawer"
    >
      {body()}
    </Drawer>
  );
}
