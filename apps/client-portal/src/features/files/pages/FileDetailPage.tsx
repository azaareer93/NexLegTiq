import { ApiError } from '@nexlegtiq/shared-api-client';
import type { PortalFileDetail } from '@nexlegtiq/shared-contracts';
import { PORTAL_TIMELINE_EVENT_TYPES } from '@nexlegtiq/shared-types';
import type { TimelineEventType } from '@nexlegtiq/shared-types';
import { Bdi, EmptyState, LoadingSkeleton, Ltr, PageHeader, useFormat } from '@nexlegtiq/shared-ui';
import { Card, Flex, Result, Tabs, Timeline, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';

import { ContactCard } from '../components/ContactCard';
import { DocumentsTab } from '../components/DocumentsTab';
import { FileStatusTag, NextHearing } from '../components/FileFacts';
import { LoadFailed } from '../components/ListStates';
import { UploadsTab } from '../components/UploadsTab';
import { useFile } from '../hooks';

const TABS = ['overview', 'documents', 'uploads'] as const;
type Tab = (typeof TABS)[number];
const isTab = (value: string | null): value is Tab => TABS.includes(value as Tab);
/** The portal's own labels (no payload, D-186); a type outside the public set never reaches here, but reads as a generic update. */
const eventKey = (type: TimelineEventType) =>
  PORTAL_TIMELINE_EVENT_TYPES.has(type)
    ? (`portal.timeline.${type}` as 'portal.timeline.FILE_OPENED')
    : 'portal.timeline.other';

/** One file: overview (status, next hearing, public timeline, contact), shared documents, and documents to send. */
export function FileDetailPage(): React.JSX.Element {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const file = useFile(id);
  const tab = isTab(params.get('tab')) ? (params.get('tab') as Tab) : 'overview';

  if (file.isError) {
    if (file.error instanceof ApiError && file.error.code === 'RES-001') {
      return (
        <Result
          status="404"
          title={t('portal.files.notFound')}
          subTitle={t('portal.files.notFoundBody')}
          data-testid="file-not-found"
          extra={<Link to="/">{t('portal.files.back')}</Link>}
        />
      );
    }
    return <LoadFailed error={file.error} onRetry={() => void file.refetch()} />;
  }
  if (!file.data) return <LoadingSkeleton />;
  const data = file.data;

  return (
    <Flex vertical gap={16}>
      <PageHeader
        title={<bdi>{data.title}</bdi>}
        subtitle={<Ltr>{data.fileNumber}</Ltr>}
        onBack={() => void navigate('/')}
      />
      <Tabs
        activeKey={tab}
        onChange={(key) => setParams(key === 'overview' ? {} : { tab: key }, { replace: true })}
        items={[
          {
            key: 'overview',
            label: t('portal.detail.tabs.overview'),
            children: <Overview file={data} />,
          },
          {
            key: 'documents',
            label: t('portal.detail.tabs.documents'),
            children: <DocumentsTab fileId={data.id} />,
          },
          {
            key: 'uploads',
            label: t('portal.detail.tabs.uploads'),
            children: <UploadsTab fileId={data.id} />,
          },
        ]}
      />
    </Flex>
  );
}

function Overview({ file }: { file: PortalFileDetail }): React.JSX.Element {
  const { t } = useTranslation();
  const format = useFormat();
  return (
    <Flex vertical gap={16}>
      <Card size="small">
        <Flex vertical gap={8}>
          <Flex gap={8} align="center">
            <Typography.Text>{t('portal.detail.status')}:</Typography.Text>
            <FileStatusTag status={file.status} />
          </Flex>
          <NextHearing hearing={file.nextHearing} />
        </Flex>
      </Card>
      <Card size="small" title={t('portal.detail.timeline')}>
        {file.timeline.length === 0 ? (
          <EmptyState title={t('portal.detail.timelineEmpty')} />
        ) : (
          <Timeline
            data-testid="portal-timeline"
            items={file.timeline.map((event, index) => ({
              key: `${event.occurredAt}-${index}`,
              children: (
                <Flex vertical>
                  <Typography.Text>{t(eventKey(event.eventType))}</Typography.Text>
                  <Typography.Text type="secondary">
                    <Bdi>{format.date(event.occurredAt, 'long')}</Bdi>
                  </Typography.Text>
                </Flex>
              ),
            }))}
          />
        )}
      </Card>
      <ContactCard officeId={file.officeId} lawyerName={file.lawyerName} />
    </Flex>
  );
}
