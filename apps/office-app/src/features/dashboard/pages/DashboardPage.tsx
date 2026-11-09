import { isErrorCode } from '@nexlegtiq/shared-types';
import {
  EmptyState,
  ErrorState,
  isApiError,
  LoadingSkeleton,
  PageHeader,
  useApiErrorHandler,
  useCan,
  useFormat,
} from '@nexlegtiq/shared-ui';
import { isolate } from '@nexlegtiq/shared-utils';
import { Button, Col, Flex, Row } from 'antd';
import { useTranslation } from 'react-i18next';

import { useSession } from '../../auth';
import { openQuickCreateCase } from '../../cases';
import { useDashboard } from '../api/use-dashboard';
import { Activity, Deadlines, Hearings, KpiRow, Team } from '../components/DashboardCards';

/** `/` (frontend.md#dashboard, D-151): the signed-in user's day, role-aware; every number links to where it is acted on. */
export function DashboardPage() {
  const { t } = useTranslation();
  const format = useFormat();
  const { referenceOf } = useApiErrorHandler();
  const name = useSession((state) => state.user?.fullName ?? '');
  const canCreate = useCan('create:case');
  const query = useDashboard();
  const data = query.data;
  const header = (
    <PageHeader
      title={t('dashboard.greeting', { name: isolate(name) })}
      subtitle={data ? format.date(data.today, 'long') : undefined}
    />
  );
  if (query.isError) {
    return (
      <section data-testid="page-dashboard">
        {header}
        <ErrorState
          code={
            isApiError(query.error) && isErrorCode(query.error.code) ? query.error.code : undefined
          }
          requestId={referenceOf(query.error)}
          onRetry={() => void query.refetch()}
        />
      </section>
    );
  }
  if (!data) {
    return (
      <section data-testid="page-dashboard">
        {header}
        <LoadingSkeleton rows={6} />
      </section>
    );
  }
  const fresh = data.openFiles.count === 0 && data.activity.items.length === 0;
  return (
    <Flex vertical gap={16} component="section" data-testid="page-dashboard">
      {header}
      {fresh && canCreate ? (
        <EmptyState
          title={t('dashboard.start.title')}
          description={t('dashboard.start.description')}
          action={
            <Button type="primary" onClick={openQuickCreateCase} data-testid="dashboard-new-case">
              {t('dashboard.start.action')}
            </Button>
          }
        />
      ) : null}
      <KpiRow data={data} />
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Flex vertical gap={16}>
            <Hearings data={data} />
            <Deadlines items={data.deadlines} />
          </Flex>
        </Col>
        <Col xs={24} lg={12}>
          <Flex vertical gap={16}>
            <Activity activity={data.activity} />
            {data.team ? <Team team={data.team} /> : null}
          </Flex>
        </Col>
      </Row>
    </Flex>
  );
}
