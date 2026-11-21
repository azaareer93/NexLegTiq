import { ApiErrorAlert, LoadingSkeleton, PageHeader, useFormat } from '@nexlegtiq/shared-ui';
import { Card, Flex, Segmented, Statistic, Table, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useAnalytics } from '../hooks';

const RANGES = [30, 90, 180] as const;
/** product.md success metrics: onboarding completion > 70%, D7 > 40%, D30 > 20%. */
const TARGETS = { ONBOARDING_COMPLETED: 70, d7: 40, d30: 20 } as const;
const COHORTS = ['d7', 'd30'] as const;

const percent = (part: number, whole: number) => (whole ? Math.round((part / whole) * 100) : 0);

/** `/analytics` (MVP-110, D-215): the onboarding funnel and D7/D30 retention, first-party and counted per office. */
export function AnalyticsPage() {
  const { t } = useTranslation();
  const format = useFormat();
  const [days, setDays] = useState<number>(90);
  const analytics = useAnalytics(days);
  const data = analytics.data;
  const signups = data?.funnel[0]?.offices ?? 0;
  const share = (n: number) =>
    t('admin.analytics.share', { value: format.number(percent(n, signups)) });
  return (
    <section data-testid="page-analytics">
      <PageHeader
        title={t('admin.analytics.title')}
        extra={
          <Segmented
            value={days}
            onChange={(v) => setDays(Number(v))}
            options={RANGES.map((d) => ({ value: d, label: t('admin.usage.days', { count: d }) }))}
            data-testid="analytics-range"
          />
        }
      />
      <Typography.Paragraph type="secondary">{t('admin.analytics.privacy')}</Typography.Paragraph>
      {analytics.isError ? <ApiErrorAlert error={analytics.error} /> : null}
      {!data ? (
        <LoadingSkeleton rows={6} />
      ) : (
        <Flex vertical gap={16}>
          <Typography.Text>
            {t('admin.analytics.period', { date: format.date(data.since, 'long') })}
          </Typography.Text>
          <Flex gap={16} wrap>
            {COHORTS.map((key) => {
              const cohort = data.retention[key];
              return (
                <Card
                  key={key}
                  size="small"
                  style={{ flex: '1 1 200px' }}
                  data-testid={`analytics-${key}`}
                >
                  <Statistic
                    title={t(`admin.analytics.${key}`)}
                    value={
                      cohort.offices
                        ? t('admin.analytics.percent', {
                            value: format.number(percent(cohort.retained, cohort.offices)),
                          })
                        : t('admin.offices.none')
                    }
                  />
                  <Flex vertical>
                    <Typography.Text type="secondary">
                      {cohort.offices
                        ? t('admin.analytics.retained', {
                            count: cohort.offices,
                            retained: format.number(cohort.retained),
                            offices: format.number(cohort.offices),
                          })
                        : t('admin.analytics.noCohort')}
                    </Typography.Text>
                    <Typography.Text type="secondary">
                      {t('admin.analytics.target', { value: format.number(TARGETS[key]) })}
                    </Typography.Text>
                  </Flex>
                </Card>
              );
            })}
            <Card size="small" style={{ flex: '1 1 200px' }} data-testid="analytics-first-case">
              <Statistic
                title={t('admin.analytics.medianFirstCase')}
                value={
                  data.medianSecondsToFirstCase === null
                    ? t('admin.offices.none')
                    : t('admin.analytics.minutes', {
                        value: format.number(data.medianSecondsToFirstCase / 60, 1),
                      })
                }
              />
            </Card>
          </Flex>
          <Card title={t('admin.analytics.funnel')}>
            <Table
              size="small"
              rowKey="event"
              pagination={false}
              dataSource={data.funnel}
              data-testid="analytics-funnel"
              columns={[
                {
                  key: 'step',
                  title: t('admin.analytics.columns.step'),
                  render: (_, r) => t(`admin.analytics.events.${r.event}`),
                },
                {
                  key: 'offices',
                  title: t('admin.analytics.columns.offices'),
                  align: 'end',
                  render: (_, r) => format.number(r.offices),
                },
                {
                  key: 'share',
                  title: t('admin.analytics.columns.share'),
                  align: 'end',
                  render: (_, r) =>
                    r.event === 'ONBOARDING_COMPLETED'
                      ? t('admin.analytics.shareTarget', {
                          value: format.number(percent(r.offices, signups)),
                          target: format.number(TARGETS.ONBOARDING_COMPLETED),
                        })
                      : share(r.offices),
                },
              ]}
            />
          </Card>
          <Card title={t('admin.analytics.steps')}>
            <Table
              size="small"
              rowKey="step"
              pagination={false}
              dataSource={data.onboardingSteps}
              data-testid="analytics-steps"
              columns={[
                {
                  key: 'step',
                  title: t('admin.analytics.columns.step'),
                  render: (_, r) => t(`onboarding.steps.${r.step}`),
                },
                {
                  key: 'offices',
                  title: t('admin.analytics.columns.offices'),
                  align: 'end',
                  render: (_, r) => format.number(r.offices),
                },
                {
                  key: 'share',
                  title: t('admin.analytics.columns.share'),
                  align: 'end',
                  render: (_, r) => share(r.offices),
                },
              ]}
            />
          </Card>
        </Flex>
      )}
    </section>
  );
}
