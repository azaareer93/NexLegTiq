import type { Dashboard, DashboardDeadline, DashboardHearing } from '@nexlegtiq/shared-contracts';
import { Bdi, Ltr, StatusTag, useFormat } from '@nexlegtiq/shared-ui';
import { isolate } from '@nexlegtiq/shared-utils';
import { Card, Col, Flex, List, Row, Statistic, Table, Tag, theme, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { eventSentence } from '../../cases/timeline/timeline-text';

/** A card heading: an h2 at the size of the theme's large text. */
function CardTitle({ children }: { readonly children: React.ReactNode }) {
  const { token } = theme.useToken();
  return (
    <Typography.Title level={2} style={{ fontSize: token.fontSizeLG, margin: 0 }}>
      {children}
    </Typography.Title>
  );
}

/** One KPI: a number that links to the page where it can be acted on. */
function Kpi({
  title,
  value,
  to,
  footer,
  testId,
}: {
  readonly title: string;
  readonly value: number;
  readonly to: string;
  readonly footer?: string;
  readonly testId: string;
}) {
  const format = useFormat();
  return (
    <Col xs={24} sm={12} lg={8} xl={4}>
      <Link to={to} data-testid={testId}>
        <Card hoverable size="small">
          <Statistic title={title} value={value} formatter={(v) => format.number(Number(v))} />
          {footer ? <Typography.Text type="secondary">{footer}</Typography.Text> : null}
        </Card>
      </Link>
    </Col>
  );
}

/**
 * Money per currency (D-162: one currency per invoice, so no sum across them). Not a link yet: the office app has no
 * invoices page (shortcut: link to it once the invoices UI story ships).
 */
function MoneyKpi({
  title,
  amounts,
  footer,
  testId,
}: {
  readonly title: string;
  readonly amounts: readonly { currency: string; amount: string }[];
  readonly footer?: string;
  readonly testId: string;
}) {
  const { t } = useTranslation();
  const format = useFormat();
  const { token } = theme.useToken();
  return (
    <Col xs={24} sm={12} lg={8} xl={4}>
      <Card size="small" data-testid={testId}>
        <Typography.Text type="secondary">{title}</Typography.Text>
        <Flex vertical style={{ fontSize: token.fontSizeHeading4 }}>
          {amounts.length === 0
            ? t('dashboard.finance.none')
            : amounts.map((m) => <Bdi key={m.currency}>{format.money(m.amount, m.currency)}</Bdi>)}
        </Flex>
        {footer ? <Typography.Text type="secondary">{footer}</Typography.Text> : null}
      </Card>
    </Col>
  );
}

const fileLink = (file: { id: string; fileNumber: string }, tab?: string) => (
  <Link to={`/cases/${file.id}${tab ? `?tab=${tab}` : ''}`}>
    <Ltr>{file.fileNumber}</Ltr>
  </Link>
);

export function Hearings({ data }: { readonly data: Dashboard }) {
  const { t } = useTranslation();
  const format = useFormat();
  return (
    <Card title={<CardTitle>{t('dashboard.today.title')}</CardTitle>} data-testid="dashboard-today">
      {data.todayHearings.length === 0 ? (
        <Typography.Text type="secondary">{t('dashboard.today.empty')}</Typography.Text>
      ) : (
        <List
          dataSource={data.todayHearings}
          renderItem={(h: DashboardHearing) => (
            <List.Item>
              <Flex gap={8} wrap align="center">
                <Typography.Text strong>{format.time(h.startsAt)}</Typography.Text>
                {t(`enums.sessionType.${h.sessionType}`)}
                {fileLink(h.file, 'sessions')}
                <Typography.Text>{isolate(h.file.title)}</Typography.Text>
                {h.id === data.nextHearingId ? (
                  <StatusTag tone="warning">{t('dashboard.today.soon')}</StatusTag>
                ) : null}
              </Flex>
            </List.Item>
          )}
        />
      )}
    </Card>
  );
}

export function Deadlines({ items }: { readonly items: readonly DashboardDeadline[] }) {
  const { t } = useTranslation();
  const format = useFormat();
  return (
    <Card
      title={<CardTitle>{t('dashboard.deadlines.title')}</CardTitle>}
      data-testid="dashboard-deadlines"
    >
      {items.length === 0 ? (
        <Typography.Text type="secondary">{t('dashboard.deadlines.empty')}</Typography.Text>
      ) : (
        <List
          dataSource={[...items]}
          renderItem={(item) => (
            <List.Item>
              <Flex gap={8} wrap align="center">
                {item.kind === 'HEARING' ? (
                  <>
                    <Typography.Text strong>{format.dateTime(item.startsAt)}</Typography.Text>
                    {t(`enums.sessionType.${item.sessionType}`)}
                    {fileLink(item.file, 'sessions')}
                  </>
                ) : (
                  <>
                    <Typography.Text strong>{format.date(item.dueDate)}</Typography.Text>
                    <Tag>{t('dashboard.deadlines.task')}</Tag>
                    <Typography.Text>{isolate(item.title)}</Typography.Text>
                    {item.file ? (
                      fileLink(item.file, 'tasks')
                    ) : (
                      <Typography.Text type="secondary">
                        {t('dashboard.deadlines.personal')}
                      </Typography.Text>
                    )}
                  </>
                )}
              </Flex>
            </List.Item>
          )}
        />
      )}
    </Card>
  );
}

export function Activity({ activity }: { readonly activity: Dashboard['activity'] }) {
  const { t } = useTranslation();
  const format = useFormat();
  return (
    <Card
      title={<CardTitle>{t('dashboard.activity.title')}</CardTitle>}
      data-testid="dashboard-activity"
    >
      {activity.items.length === 0 ? (
        <Typography.Text type="secondary">{t('dashboard.activity.empty')}</Typography.Text>
      ) : (
        <List
          dataSource={activity.items}
          renderItem={(event) => (
            <List.Item>
              <Flex vertical>
                <Typography.Text>{eventSentence(t, format, event, activity.names)}</Typography.Text>
                <Typography.Text type="secondary">
                  {fileLink(event.file, 'timeline')} {format.relative(event.occurredAt)}
                </Typography.Text>
              </Flex>
            </List.Item>
          )}
        />
      )}
    </Card>
  );
}

export function Team({ team }: { readonly team: NonNullable<Dashboard['team']> }) {
  const { t } = useTranslation();
  const format = useFormat();
  return (
    <Card title={<CardTitle>{t('dashboard.team.title')}</CardTitle>} data-testid="dashboard-team">
      <Table
        size="small"
        pagination={false}
        rowKey="userId"
        dataSource={[...team.workload]}
        scroll={{ x: true }}
        columns={[
          {
            key: 'name',
            title: t('dashboard.team.lawyer'),
            render: (_, row) => isolate(row.fullName),
          },
          {
            key: 'files',
            title: t('dashboard.team.openFiles'),
            render: (_, row) => format.number(row.openFiles),
          },
          {
            key: 'tasks',
            title: t('dashboard.team.overdueTasks'),
            render: (_, row) => format.number(row.overdueTasks),
          },
        ]}
      />
    </Card>
  );
}

/** The KPI cards; client and office counts only for those who get them (D-151). */
export function KpiRow({ data }: { readonly data: Dashboard }) {
  const { t } = useTranslation();
  return (
    <Row gutter={[16, 16]}>
      <Kpi
        testId="kpi-open-files"
        title={t('dashboard.kpi.openFiles')}
        value={data.openFiles.count}
        to="/cases?scope=mine&status=OPEN"
        footer={t('dashboard.kpi.openedThisWeek', { count: data.openFiles.openedThisWeek })}
      />
      <Kpi
        testId="kpi-hearings"
        title={t('dashboard.kpi.todayHearings')}
        value={data.todayHearings.length}
        to="/calendar"
      />
      <Kpi
        testId="kpi-overdue"
        title={t('dashboard.kpi.overdueTasks')}
        value={data.overdueTasks}
        to="/tasks"
      />
      <Kpi
        testId="kpi-documents"
        title={t('dashboard.kpi.newDocuments')}
        value={data.newDocuments}
        to="/documents"
      />
      {data.newClientsThisMonth === null ? null : (
        <Kpi
          testId="kpi-clients"
          title={t('dashboard.kpi.newClients')}
          value={data.newClientsThisMonth}
          to="/clients"
        />
      )}
      {data.team ? (
        <Kpi
          testId="kpi-office-hearings"
          title={t('dashboard.kpi.hearingsThisWeek')}
          value={data.team.hearingsThisWeek}
          to="/calendar"
        />
      ) : null}
      {data.finance ? (
        <>
          <MoneyKpi
            testId="kpi-unpaid"
            title={t('dashboard.finance.unpaid')}
            amounts={data.finance.unpaid}
            footer={t('dashboard.finance.overdue', { count: data.finance.overdueCount })}
          />
          <MoneyKpi
            testId="kpi-revenue"
            title={t('dashboard.finance.revenue')}
            amounts={data.finance.revenueThisMonth}
          />
        </>
      ) : null}
    </Row>
  );
}
