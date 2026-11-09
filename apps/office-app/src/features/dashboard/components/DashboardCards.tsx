import type { Dashboard, DashboardDeadline, DashboardHearing } from '@nexlegtiq/shared-contracts';
import { Ltr, useFormat } from '@nexlegtiq/shared-ui';
import { isolate } from '@nexlegtiq/shared-utils';
import { Card, Col, Flex, List, Row, Statistic, Table, Tag, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { eventSentence } from '../../cases/timeline/timeline-text';

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
  return (
    <Col xs={24} sm={12} lg={8} xl={4}>
      <Link to={to} data-testid={testId}>
        <Card hoverable size="small">
          <Statistic title={title} value={value} />
          {footer ? <Typography.Text type="secondary">{footer}</Typography.Text> : null}
        </Card>
      </Link>
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
    <Card
      title={
        <Typography.Title level={2} style={{ fontSize: 16, margin: 0 }}>
          {t('dashboard.today.title')}
        </Typography.Title>
      }
      data-testid="dashboard-today"
    >
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
                  <Tag color="orange">{t('dashboard.today.soon')}</Tag>
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
      title={
        <Typography.Title level={2} style={{ fontSize: 16, margin: 0 }}>
          {t('dashboard.deadlines.title')}
        </Typography.Title>
      }
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
      title={
        <Typography.Title level={2} style={{ fontSize: 16, margin: 0 }}>
          {t('dashboard.activity.title')}
        </Typography.Title>
      }
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
  return (
    <Card
      title={
        <Typography.Title level={2} style={{ fontSize: 16, margin: 0 }}>
          {t('dashboard.team.title')}
        </Typography.Title>
      }
      data-testid="dashboard-team"
    >
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
          { key: 'files', title: t('dashboard.team.openFiles'), dataIndex: 'openFiles' },
          { key: 'tasks', title: t('dashboard.team.overdueTasks'), dataIndex: 'overdueTasks' },
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
        to="/cases?scope=mine"
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
    </Row>
  );
}
