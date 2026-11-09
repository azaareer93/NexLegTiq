import { ApiError } from '@nexlegtiq/shared-api-client';
import type { AdminOfficeDetail, AdminSubscriptionRow } from '@nexlegtiq/shared-contracts';
import { isErrorCode } from '@nexlegtiq/shared-types';
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
import { Alert, Button, Card, Descriptions, Table } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router';

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
        subtitle={
          <StatusTag tone={suspended ? 'error' : 'success'}>
            {t(`admin.offices.status.${office.status}`)}
          </StatusTag>
        }
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
          message={t('admin.offices.suspension.title', {
            date: format.dateTime(office.suspension.at),
          })}
          description={
            <>
              {t('admin.offices.suspension.reason')}: <Bdi>{office.suspension.reason}</Bdi>
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
