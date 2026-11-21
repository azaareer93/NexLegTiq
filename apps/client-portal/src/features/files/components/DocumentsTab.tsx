import { DownloadOutlined } from '@ant-design/icons';
import { Bdi, EmptyState, LoadingSkeleton, useFormat } from '@nexlegtiq/shared-ui';
import { isolate } from '@nexlegtiq/shared-utils';
import { Button, Card, Flex, Typography } from 'antd';
import { useTranslation } from 'react-i18next';

import { useDocuments, useDownload } from '../hooks';
import { LoadFailed, useSize } from './ListStates';

/** The documents the office shared on the file, each downloadable through a short-lived link (audited). */
export function DocumentsTab({ fileId }: { readonly fileId: string }): React.JSX.Element {
  const { t } = useTranslation();
  const format = useFormat();
  const size = useSize();
  const documents = useDocuments(fileId);
  const download = useDownload();

  if (documents.isError) {
    return <LoadFailed error={documents.error} onRetry={() => void documents.refetch()} />;
  }
  if (!documents.data) return <LoadingSkeleton />;
  if (documents.data.length === 0) {
    return (
      <EmptyState
        title={t('portal.documents.empty')}
        description={t('portal.documents.emptyHint')}
      />
    );
  }
  return (
    <Flex vertical gap={8} data-testid="documents-list">
      {documents.data.map((document) => (
        <Card size="small" key={document.id}>
          <Flex justify="space-between" align="center" gap={8}>
            <Flex vertical style={{ minInlineSize: 0 }}>
              <Typography.Text ellipsis>
                <bdi>{document.name}</bdi>
              </Typography.Text>
              <Typography.Text type="secondary">
                <Bdi>{format.date(document.createdAt)}</Bdi>
                {t('timeline.separator')}
                <Bdi>{size(document.sizeBytes)}</Bdi>
              </Typography.Text>
            </Flex>
            <Button
              icon={<DownloadOutlined aria-hidden />}
              aria-label={t('portal.documents.download', { name: isolate(document.name) })}
              loading={download.isPending && download.variables === document.id}
              onClick={() => download.mutate(document.id)}
              data-testid={`download-${document.id}`}
            >
              {t('portal.documents.downloadLabel')}
            </Button>
          </Flex>
        </Card>
      ))}
    </Flex>
  );
}
