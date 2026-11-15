import type { InvoiceListItem } from '@nexlegtiq/shared-contracts';
import { Bdi, Ltr, useFormat } from '@nexlegtiq/shared-ui';
import { Table } from 'antd';
import { useTranslation } from 'react-i18next';

import { InvoiceActions, InvoiceStatusTag } from './InvoiceActions';

interface Props {
  readonly invoices: readonly InvoiceListItem[];
  readonly total: number;
  readonly page: number;
  readonly onPage: (page: number) => void;
  readonly loading?: boolean;
  /** Inside a case the file column says nothing new. */
  readonly showFile?: boolean;
}

/** Invoices with their state and actions; money in the invoice's currency (`formatMoney`, D-092). */
export function InvoicesTable({
  invoices,
  total,
  page,
  onPage,
  loading = false,
  showFile = true,
}: Props) {
  const { t } = useTranslation();
  const format = useFormat();
  return (
    <Table<InvoiceListItem>
      data-testid="invoices-table"
      rowKey="id"
      loading={loading}
      dataSource={[...invoices]}
      scroll={{ x: 'max-content' }}
      pagination={{ current: page, pageSize: 20, total, onChange: onPage, showSizeChanger: false }}
      columns={[
        {
          title: t('billing.invoices.columns.number'),
          render: (_, i) =>
            i.invoiceNumber ? <Ltr>{i.invoiceNumber}</Ltr> : t('billing.invoices.draftNumber'),
        },
        {
          title: t('billing.invoices.columns.client'),
          render: (_, i) => <Bdi>{i.client.displayName}</Bdi>,
        },
        ...(showFile
          ? [
              {
                title: t('billing.invoices.columns.file'),
                render: (_: unknown, i: InvoiceListItem) =>
                  i.file ? <Ltr>{i.file.fileNumber}</Ltr> : t('billing.invoices.consolidated'),
              },
            ]
          : []),
        {
          title: t('billing.invoices.columns.issueDate'),
          render: (_, i) => (i.issueDate ? format.date(i.issueDate) : '—'),
        },
        {
          title: t('billing.invoices.columns.dueDate'),
          render: (_, i) => (i.dueDate ? format.date(i.dueDate) : '—'),
        },
        {
          title: t('billing.invoices.columns.total'),
          align: 'end',
          render: (_, i) => <Bdi>{format.money(i.total, i.currency)}</Bdi>,
        },
        {
          title: t('billing.invoices.columns.status'),
          render: (_, i) => <InvoiceStatusTag status={i.status} />,
        },
        {
          title: t('billing.invoices.columns.actions'),
          render: (_, i) => <InvoiceActions invoice={i} />,
        },
      ]}
    />
  );
}
