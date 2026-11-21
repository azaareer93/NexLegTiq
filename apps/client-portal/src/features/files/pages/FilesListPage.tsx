import { EmptyState, LoadingSkeleton, Ltr, PageHeader } from '@nexlegtiq/shared-ui';
import { Card, Flex, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { useOffices } from '../../auth';
import { ContactCard } from '../components/ContactCard';
import { FileStatusTag, NextHearing } from '../components/FileFacts';
import { LoadFailed } from '../components/ListStates';
import { useFiles } from '../hooks';

/** My files: one card per file, the next hearing first in mind; the office's contact card below. */
export function FilesListPage(): React.JSX.Element {
  const { t } = useTranslation();
  const files = useFiles();
  const offices = useOffices();
  const officeIds = [...new Set(offices.map((office) => office.officeId))];
  const severalOffices = officeIds.length > 1;

  return (
    <Flex vertical gap={16}>
      <PageHeader title={t('portal.files.title')} />
      <FilesContent severalOffices={severalOffices} files={files} />
      {officeIds.map((id) => (
        <ContactCard key={id} officeId={id} />
      ))}
    </Flex>
  );
}

function FilesContent({
  files,
  severalOffices,
}: {
  files: ReturnType<typeof useFiles>;
  severalOffices: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  if (files.isError) return <LoadFailed error={files.error} onRetry={() => void files.refetch()} />;
  if (!files.data) return <LoadingSkeleton />;
  if (files.data.length === 0) {
    return <EmptyState title={t('portal.files.empty')} description={t('portal.files.emptyHint')} />;
  }
  return (
    <Flex vertical gap={12} data-testid="files-list">
      {files.data.map((file) => (
        <Link key={file.id} to={`/files/${file.id}`} data-testid={`file-${file.id}`}>
          <Card size="small" hoverable>
            <Flex vertical gap={4}>
              <Flex justify="space-between" align="start" gap={8}>
                <Typography.Text strong>
                  <bdi>{file.title}</bdi>
                </Typography.Text>
                <FileStatusTag status={file.status} />
              </Flex>
              <Typography.Text type="secondary">
                <Ltr>{file.fileNumber}</Ltr>
                {severalOffices ? (
                  <>
                    {t('timeline.separator')}
                    <bdi>{file.officeName}</bdi>
                  </>
                ) : null}
              </Typography.Text>
              <NextHearing hearing={file.nextHearing} />
            </Flex>
          </Card>
        </Link>
      ))}
    </Flex>
  );
}
