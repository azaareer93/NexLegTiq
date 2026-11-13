import { ApiError } from '@nexlegtiq/shared-api-client';
import type {
  AdminOfficeDetail,
  AdminOfficeStatistics,
  AdminSubscriptionRow,
} from '@nexlegtiq/shared-contracts';
import { FILE_STATUSES, isErrorCode } from '@nexlegtiq/shared-types';
import {
  Bdi,
  EmptyState,
  ErrorState,
  isApiError,
  LoadingSkeleton,
  Ltr,
  PageHeader,
  StatusTag,
  useApiErrorHandler,
  useFormat,
} from '@nexlegtiq/shared-ui';
import { Alert, Button, Card, Descriptions, Space, Table } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router';

import { AtRiskTag } from '../components/AtRiskTag';
import { OfficeActionModal } from '../components/OfficeActionModal';
import { useOffice } from '../hooks';

function Subscriptions({ rows }: { readonly rows: AdminSubscriptionRow[] }): React.JSX.Element {
  const { t } = useTranslation();
  const format = useFormat();
  return (
    <Table<AdminSubscriptionRow>
      data-testid="office-subscriptions"
      rowKey="id"
      dataSource={rows}
      pagination={false}
      scroll={{ x: 'max-content' }}
      columns={[
        {
          title: t('admin.offices.subscriptions.plan'),
          render: (_, r) => <Bdi>{r.plan.name}</Bdi>,
        },
        {
          title: t('admin.offices.subscriptions.status'),
          render: (_, r) => t(`enums.subscriptionStatus.${r.status}`),
        },
        {
          title: t('admin.offices.subscriptions.start'),
          render: (_, r) => format.date(r.currentPeriodStart),
        },
        {
          title: t('admin.offices.subscriptions.end'),
          render: (_, r) =>
            r.currentPeriodEnd ? format.date(r.currentPeriodEnd) : t('admin.offices.none'),
        },
        {
          title: t('admin.offices.subscriptions.trialEnds'),
          render: (_, r) => (r.trialEndsAt ? format.date(r.trialEndsAt) : t('admin.offices.none')),
        },
      ]}
    />
  );
}

/** D-164: counts only, over the last 30 days where the label says so. */
function Statistics({ stats }: { readonly stats: AdminOfficeStatistics }): React.JSX.Element {
  const { t } = useTranslation();
  const format = useFormat();
  const n = (value: number) => format.number(value);
  const onOff = (on: boolean) => t(on ? 'admin.offices.stats.on' : 'admin.offices.stats.off');
  return (
    <Card
      title={t('admin.offices.stats.title', { days: n(30) })}
      style={{ marginBlockEnd: 16 }}
      data-testid="office-statistics"
    >
      <Descriptions column={{ xs: 1, md: 2 }}>
        <Descriptions.Item label={t('admin.offices.stats.signedIn30d')}>
          {n(stats.signedIn30d)}
        </Descriptions.Item>
        <Descriptions.Item label={t('admin.offices.stats.writes30d')}>
          {n(stats.writes30d)}
        </Descriptions.Item>
        <Descriptions.Item label={t('admin.offices.stats.filesNew30d')}>
          {n(stats.filesNew30d)}
        </Descriptions.Item>
        <Descriptions.Item label={t('admin.offices.stats.documentsNew30d')}>
          {n(stats.documentsNew30d)}
        </Descriptions.Item>
        <Descriptions.Item label={t('admin.offices.stats.documents')}>
          {n(stats.documents)}
        </Descriptions.Item>
        <Descriptions.Item label={t('admin.offices.stats.filesByStatus')}>
          {FILE_STATUSES.map((status, index) => (
            <span key={status}>
              {index > 0 ? t('admin.offices.stats.separator') : null}
              <Bdi>
                {t('admin.offices.stats.statusCount', {
                  status: t(`enums.fileStatus.${status}`),
                  count: n(stats.filesByStatus[status]),
                })}
              </Bdi>
            </span>
          ))}
        </Descriptions.Item>
        <Descriptions.Item label={t('admin.offices.stats.aiEnabled')}>
          {onOff(stats.aiEnabled)}
        </Descriptions.Item>
        <Descriptions.Item label={t('admin.offices.stats.ocrEnabled')}>
          {onOff(stats.ocrEnabled)}
        </Descriptions.Item>
      </Descriptions>
    </Card>
  );
}

function OfficeStatus({ office }: { readonly office: AdminOfficeDetail }): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <Space size={4} wrap>
      <StatusTag tone={office.status === 'SUSPENDED' ? 'error' : 'success'}>
        {t(`admin.offices.status.${office.status}`)}
      </StatusTag>
      {office.atRisk ? <AtRiskTag id={office.id} /> : null}
    </Space>
  );
}

function Detail({ office }: { readonly office: AdminOfficeDetail }): React.JSX.Element {
  const { t } = useTranslation();
  const format = useFormat();
  const navigate = useNavigate();
  const [action, setAction] = useState<'suspend' | 'reactivate' | null>(null);
  const suspended = office.status === 'SUSPENDED';
  const none = t('admin.offices.none');

  return (
    <>
      <PageHeader
        onBack={() => void navigate('/offices')}
        title={<Bdi>{office.name}</Bdi>}
        subtitle={<OfficeStatus office={office} />}
        extra={
          <Button
            danger={!suspended}
            onClick={() => setAction(suspended ? 'reactivate' : 'suspend')}
            data-testid="office-action"
          >
            {t(suspended ? 'admin.offices.actions.reactivate' : 'admin.offices.actions.suspend')}
          </Button>
        }
      />
      {suspended && office.suspension ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBlockEnd: 16 }}
          data-testid="office-suspension"
          message={
            <>
              {t('admin.offices.suspension.title')}{' '}
              <Bdi>{format.dateTime(office.suspension.at)}</Bdi>
            </>
          }
          description={
            <>
              {t('admin.offices.suspension.reason')} <Bdi>{office.suspension.reason}</Bdi>
            </>
          }
        />
      ) : null}
      <Card title={t('admin.offices.detail.profile')} style={{ marginBlockEnd: 16 }}>
        <Descriptions column={{ xs: 1, md: 2 }}>
          <Descriptions.Item label={t('admin.offices.columns.jurisdiction')}>
            {t(`enums.jurisdiction.${office.jurisdiction}`)}
          </Descriptions.Item>
          <Descriptions.Item label={t('admin.offices.detail.accountType')}>
            {t(`enums.accountType.${office.accountType}`)}
          </Descriptions.Item>
          <Descriptions.Item label={t('admin.offices.detail.email')}>
            {office.email ? <Ltr>{office.email}</Ltr> : none}
          </Descriptions.Item>
          <Descriptions.Item label={t('admin.offices.detail.phone')}>
            {office.phone ? <Ltr>{office.phone}</Ltr> : none}
          </Descriptions.Item>
          <Descriptions.Item label={t('admin.offices.detail.currency')}>
            <Ltr>{office.currency}</Ltr>
          </Descriptions.Item>
          <Descriptions.Item label={t('admin.offices.detail.timezone')}>
            <Ltr>{office.timezone}</Ltr>
          </Descriptions.Item>
          <Descriptions.Item label={t('admin.offices.columns.created')}>
            {format.dateTime(office.createdAt)}
          </Descriptions.Item>
          <Descriptions.Item label={t('admin.offices.columns.lastActivity')}>
            {office.lastActivityAt ? format.dateTime(office.lastActivityAt) : none}
          </Descriptions.Item>
          <Descriptions.Item label={t('admin.offices.columns.lastWrite')}>
            {office.lastWriteAt ? format.dateTime(office.lastWriteAt) : none}
          </Descriptions.Item>
        </Descriptions>
      </Card>
      <Card
        title={t('admin.offices.detail.usage')}
        style={{ marginBlockEnd: 16 }}
        data-testid="office-usage"
      >
        <Descriptions column={{ xs: 1, md: 2 }}>
          <Descriptions.Item label={t('admin.offices.columns.users')}>
            {format.number(office.usage.activeUsers)}
          </Descriptions.Item>
          <Descriptions.Item label={t('admin.offices.columns.files')}>
            {format.number(office.usage.liveFiles)}
          </Descriptions.Item>
          <Descriptions.Item label={t('admin.offices.columns.storage')}>
            {t('admin.offices.mb', { value: format.number(office.usage.storageMb) })}
          </Descriptions.Item>
          <Descriptions.Item label={t('admin.offices.columns.ai')}>
            {format.number(office.usage.aiThisMonth)}
          </Descriptions.Item>
        </Descriptions>
      </Card>
      <Statistics stats={office.statistics} />
      <Card title={t('admin.offices.detail.subscriptions')}>
        <Subscriptions rows={office.subscriptions} />
      </Card>
      {action ? (
        <OfficeActionModal officeId={office.id} kind={action} onClose={() => setAction(null)} />
      ) : null}
    </>
  );
}

/** `/offices/:id`: profile, usage, subscriptions and the suspend / reactivate action. */
export function OfficeDetailPage(): React.JSX.Element {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const { referenceOf } = useApiErrorHandler();
  const navigate = useNavigate();
  const query = useOffice(id);

  if (query.data) {
    return (
      <section data-testid="page-office">
        <Detail office={query.data} />
      </section>
    );
  }
  if (query.isError) {
    if (query.error instanceof ApiError && query.error.status === 404) {
      return (
        <div data-testid="office-not-found">
          <EmptyState
            title={t('admin.offices.notFound')}
            action={
              <Button onClick={() => void navigate('/offices')}>{t('admin.offices.back')}</Button>
            }
          />
        </div>
      );
    }
    const code = isApiError(query.error) ? query.error.code : undefined;
    return (
      <div data-testid="office-error">
        <ErrorState
          code={code !== undefined && isErrorCode(code) ? code : undefined}
          requestId={referenceOf(query.error)}
          onRetry={() => void query.refetch()}
        />
      </div>
    );
  }
  return <LoadingSkeleton rows={6} />;
}
