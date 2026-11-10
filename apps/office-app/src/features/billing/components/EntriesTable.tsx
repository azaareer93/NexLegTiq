import { LockOutlined } from '@ant-design/icons';
import type { TimeEntry, TimeTotals } from '@nexlegtiq/shared-contracts';
import { Bdi, useFormat } from '@nexlegtiq/shared-ui';
import { Button, Card, Descriptions, Flex, Table, Tag } from 'antd';
import type { TableColumnsType } from 'antd';
import { useTranslation } from 'react-i18next';

import { PAGE_SIZE } from '../api/use-billing';

const DASH = '—';

/** Hours and amounts of the file (D-152); amounts only come back for holders of invoice rights. */
export function Totals({ totals }: { readonly totals: TimeTotals }) {
  const { t } = useTranslation();
  const format = useFormat();
  const hours = (value: string) => t('billing.hoursValue', { value: format.number(value, 2) });
  const money = (value: string | null) =>
    value === null ? null : format.money(value, totals.currency);
  const items = [
    { key: 'billableHours', value: hours(totals.billableHours) },
    { key: 'nonBillableHours', value: hours(totals.nonBillableHours) },
    { key: 'unbilledHours', value: hours(totals.unbilledHours) },
    { key: 'billableAmount', value: money(totals.billableAmount) },
    { key: 'unbilledAmount', value: money(totals.unbilledAmount) },
  ] as const;
  return (
    <Card size="small" title={t('billing.totals.title')} data-testid="billing-totals">
      <Descriptions
        size="small"
        column={{ xs: 1, sm: 2, lg: 3 }}
        items={items
          .filter((item) => item.value !== null)
          .map((item) => ({
            key: item.key,
            label: t(`billing.totals.${item.key}`),
            children: <Bdi>{item.value}</Bdi>,
          }))}
      />
    </Card>
  );
}

interface Props {
  readonly entries: readonly TimeEntry[];
  readonly total: number;
  readonly page: number;
  readonly onPage: (page: number) => void;
  /** Money columns: holders of invoice rights (the API sends null to the others). */
  readonly showMoney: boolean;
  /** Edit and delete buttons (`log:time`, file not archived). */
  readonly canLog: boolean;
  readonly onEdit: (entry: TimeEntry) => void;
  readonly onDelete: (entry: TimeEntry) => void;
}

/** The entries of a file; invoiced rows carry a tag and no actions (BIZ-006). */
export function EntriesTable({
  entries,
  total,
  page,
  onPage,
  showMoney,
  canLog,
  onEdit,
  onDelete,
}: Props) {
  const { t } = useTranslation();
  const format = useFormat();
  const money = (value: string | null, currency: string) =>
    value === null ? DASH : <Bdi>{format.money(value, currency)}</Bdi>;
  const columns: TableColumnsType<TimeEntry> = [
    {
      key: 'date',
      title: t('billing.columns.date'),
      render: (_, row) => format.date(row.workDate),
    },
    {
      key: 'user',
      title: t('billing.columns.user'),
      render: (_, row) => <Bdi>{row.user.fullName}</Bdi>,
    },
    {
      key: 'description',
      title: t('billing.columns.description'),
      render: (_, row) => <span style={{ unicodeBidi: 'plaintext' }}>{row.description}</span>,
    },
    {
      key: 'duration',
      title: t('billing.columns.duration'),
      render: (_, row) => t('billing.hoursValue', { value: format.number(row.durationHours, 2) }),
    },
    {
      key: 'rate',
      title: t('billing.columns.rate'),
      hidden: !showMoney,
      render: (_, row) => money(row.hourlyRate, row.currency),
    },
    {
      key: 'amount',
      title: t('billing.columns.amount'),
      hidden: !showMoney,
      render: (_, row) => money(row.amount, row.currency),
    },
    {
      key: 'billable',
      title: t('billing.columns.billable'),
      render: (_, row) => t(row.isBillable ? 'billing.billable' : 'billing.nonBillable'),
    },
    {
      key: 'invoiced',
      title: t('billing.columns.invoiced'),
      render: (_, row) =>
        row.invoiced ? (
          <Tag icon={<LockOutlined aria-hidden />} title={t('billing.invoicedLocked')}>
            {t('billing.invoiced')}
          </Tag>
        ) : (
          DASH
        ),
    },
    {
      key: 'actions',
      title: t('billing.columns.actions'),
      hidden: !canLog,
      render: (_, row) =>
        row.invoiced ? null : (
          <Flex gap={4}>
            <Button
              size="small"
              onClick={() => onEdit(row)}
              aria-label={t('billing.row.edit', { date: format.date(row.workDate) })}
              data-testid={`entry-edit-${row.id}`}
            >
              {t('common.actions.edit')}
            </Button>
            <Button
              size="small"
              danger
              onClick={() => onDelete(row)}
              aria-label={t('billing.row.delete', { date: format.date(row.workDate) })}
              data-testid={`entry-delete-${row.id}`}
            >
              {t('common.actions.delete')}
            </Button>
          </Flex>
        ),
    },
  ];
  return (
    <Table<TimeEntry>
      rowKey="id"
      size="small"
      columns={columns}
      dataSource={[...entries]}
      scroll={{ x: 'max-content' }}
      pagination={{
        current: page,
        pageSize: PAGE_SIZE,
        total,
        showSizeChanger: false,
        hideOnSinglePage: true,
        onChange: onPage,
      }}
      data-testid="billing-table"
    />
  );
}
