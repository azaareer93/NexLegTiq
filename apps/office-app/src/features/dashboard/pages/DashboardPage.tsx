import type { Dashboard } from '@nexlegtiq/shared-contracts';
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
import { OnboardingNudge } from '../../onboarding';
import { useDashboard } from '../api/use-dashboard';
import { Activity, Deadlines, Hearings, KpiRow, Team } from '../components/DashboardCards';
import { QuickStart } from '../components/QuickStart';

/**
 * The quick-start checklist for whoever sets up the office (D-210); other creators in an empty office get a prompt for
 * the first case instead (the checklist carries that step).
 */
function FirstSteps({ data }: { readonly data: Dashboard }) {
  const { t } = useTranslation();
  const canCreate = useCan('create:case');
  if (data.setup) return <QuickStart setup={data.setup} />;
  const fresh = data.openFiles.count === 0 && data.activity.items.length === 0;
  if (!fresh || !canCreate) return null;
  return (
    <EmptyState
      illustration="cases"
      title={t('dashboard.start.title')}
      description={t('dashboard.start.description')}
      action={
        <Button type="primary" onClick={openQuickCreateCase} data-testid="dashboard-new-case">
          {t('dashboard.start.action')}
        </Button>
      }
    />
  );
}

/** `/` (frontend.md#dashboard, D-151): the signed-in user's day, role-aware; every number links to where it is acted on. */
export function DashboardPage() {
  const { t } = useTranslation();
  const format = useFormat();
  const { referenceOf } = useApiErrorHandler();
  const name = useSession((state) => state.user?.fullName ?? '');
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
  return (
    <Flex vertical gap={16} component="section" data-testid="page-dashboard">
      {header}
      <OnboardingNudge />
      <FirstSteps data={data} />
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
