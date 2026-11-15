import { ApiErrorAlert, Bdi, LoadingSkeleton, PageHeader, useFormat } from '@nexlegtiq/shared-ui';
import { Card, Flex, Segmented, Statistic, Table } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { CostChart } from '../components/CostChart';
import { useUsage } from '../hooks';

const RANGES = [7, 30, 90] as const;
const MB = 1024 * 1024;

/** `/usage` (MVP-103, D-183): AI cost, storage, active users and the signup funnel across offices. */
export function UsagePage() {
  const { t } = useTranslation();
  const format = useFormat();
  const [days, setDays] = useState<number>(30);
  const usage = useUsage(days);
  const data = usage.data;
  return (
    <section data-testid="page-usage">
      <PageHeader
        title={t('admin.usage.title')}
        extra={
          <Segmented
            value={days}
            onChange={(v) => setDays(Number(v))}
            options={RANGES.map((d) => ({ value: d, label: t('admin.usage.days', { count: d }) }))}
            data-testid="usage-range"
          />
        }
      />
      {usage.isError ? <ApiErrorAlert error={usage.error} /> : null}
      {!data ? (
        <LoadingSkeleton rows={6} />
      ) : (
        <Flex vertical gap={16}>
          <Flex gap={16} wrap>
            <Card size="small" style={{ flex: '1 1 160px' }}>
              <Statistic
                title={t('admin.usage.dau')}
                value={format.number(data.activeUsers.daily)}
              />
            </Card>
            <Card size="small" style={{ flex: '1 1 160px' }}>
              <Statistic
                title={t('admin.usage.wau')}
                value={format.number(data.activeUsers.weekly)}
              />
            </Card>
            <Card size="small" style={{ flex: '2 1 320px' }} data-testid="usage-funnel">
              <Flex gap={24} wrap>
                <Statistic
                  title={t('admin.usage.funnel.offices')}
                  value={format.number(data.signups.offices)}
                />
                <Statistic
                  title={t('admin.usage.funnel.verified')}
                  value={format.number(data.signups.verified)}
                />
                <Statistic
                  title={t('admin.usage.funnel.withCase')}
                  value={format.number(data.signups.withCase)}
                />
              </Flex>
            </Card>
          </Flex>
          <Card title={t('admin.usage.costByDay')}>
            <CostChart days={data.aiCostByDay} />
          </Card>
          <Card title={t('admin.usage.costByOffice')}>
            <Table
              size="small"
              rowKey={(r) => `${r.officeId}-${r.model}`}
              pagination={false}
              dataSource={data.aiCostByOffice}
              data-testid="usage-cost-offices"
              columns={[
                {
                  key: 'office',
                  title: t('admin.usage.columns.office'),
                  render: (_, r) => <Bdi>{r.officeName}</Bdi>,
                },
                {
                  key: 'model',
                  title: t('admin.usage.columns.model'),
                  render: (_, r) => <span dir="ltr">{r.model}</span>,
                },
                {
                  key: 'ops',
                  title: t('admin.usage.columns.operations'),
                  align: 'end',
                  render: (_, r) => format.number(r.operations),
                },
                {
                  key: 'cost',
                  title: t('admin.usage.columns.cost'),
                  align: 'end',
                  render: (_, r) => format.money(r.costUsd, 'USD'),
                },
              ]}
            />
          </Card>
          <Card title={t('admin.usage.storage')}>
            <Table
              size="small"
              rowKey="officeId"
              pagination={false}
              dataSource={data.storageByOffice}
              data-testid="usage-storage"
              columns={[
                {
                  key: 'office',
                  title: t('admin.usage.columns.office'),
                  render: (_, r) => <Bdi>{r.officeName}</Bdi>,
                },
                {
                  key: 'size',
                  title: t('admin.usage.columns.size'),
                  align: 'end',
                  render: (_, r) =>
                    t('admin.usage.megabytes', {
                      value: format.number(Math.round(Number(r.bytes) / MB)),
                    }),
                },
              ]}
            />
          </Card>
        </Flex>
      )}
    </section>
  );
}
