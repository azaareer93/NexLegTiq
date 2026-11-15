import { WarningOutlined } from '@ant-design/icons';
import { ApiErrorAlert, PageHeader, useFormat } from '@nexlegtiq/shared-ui';
import { Table, Tag, Typography } from 'antd';
import { useTranslation } from 'react-i18next';

import { useQueues } from '../hooks';

/**
 * `/queues` (D-183): jobs per queue, failed ones marked with an icon and words. Bull Board itself (the job details) is
 * served by the API where it is enabled, never in production until the platform login guards it (D-084).
 */
export function QueuesPage() {
  const { t } = useTranslation();
  const format = useFormat();
  const queues = useQueues();
  return (
    <section data-testid="page-queues">
      <PageHeader title={t('admin.queues.title')} />
      <Typography.Paragraph type="secondary">{t('admin.queues.boardHint')}</Typography.Paragraph>
      {queues.isError ? <ApiErrorAlert error={queues.error} /> : null}
      <Table
        size="small"
        rowKey="name"
        loading={queues.isPending}
        pagination={false}
        dataSource={queues.data ?? []}
        data-testid="queues-table"
        columns={[
          {
            key: 'name',
            title: t('admin.queues.columns.name'),
            render: (_, q) => <span dir="ltr">{q.name}</span>,
          },
          {
            key: 'waiting',
            title: t('admin.queues.columns.waiting'),
            align: 'end',
            render: (_, q) => format.number(q.waiting),
          },
          {
            key: 'active',
            title: t('admin.queues.columns.active'),
            align: 'end',
            render: (_, q) => format.number(q.active),
          },
          {
            key: 'delayed',
            title: t('admin.queues.columns.delayed'),
            align: 'end',
            render: (_, q) => format.number(q.delayed),
          },
          {
            key: 'failed',
            title: t('admin.queues.columns.failed'),
            align: 'end',
            render: (_, q) =>
              q.failed > 0 ? (
                <Tag
                  color="error"
                  icon={<WarningOutlined aria-hidden />}
                  data-testid={`queue-failed-${q.name}`}
                >
                  {t('admin.queues.failed', {
                    count: q.failed,
                    formatted: format.number(q.failed),
                  })}
                </Tag>
              ) : (
                format.number(0)
              ),
          },
        ]}
      />
    </section>
  );
}
