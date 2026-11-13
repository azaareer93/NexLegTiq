import type { Page } from '@nexlegtiq/shared-api-client';
import type { CaseListItem, ClientDocument, InvoiceListItem } from '@nexlegtiq/shared-contracts';
import { isErrorCode } from '@nexlegtiq/shared-types';
import {
  Bdi,
  EmptyState,
  ErrorState,
  isApiError,
  LoadingSkeleton,
  Ltr,
  StatusTag,
  useApiErrorHandler,
  useFormat,
} from '@nexlegtiq/shared-ui';
import type { UseQueryResult } from '@tanstack/react-query';
import { Table } from 'antd';
import type { TableColumnsType } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { useCasesList } from '../../cases/api/use-cases';
import { FileStatusTag, TitleLink } from '../../cases/components/case-cells';
import { STATUS_TONE } from '../../cases/documents/document-upload';
import { useClientDocuments, useClientInvoices } from '../api/use-client-profile';

const PAGE_SIZE = 20;

/** Skeleton, error, empty state or one page of a table — the tabs below differ only in columns. */
function PagedTable<T extends { id: string }>({
  query,
  page,
  onPage,
  columns,
  empty,
  testId,
}: {
  readonly query: UseQueryResult<Page<T>>;
  readonly page: number;
  readonly onPage: (page: number) => void;
  readonly columns: TableColumnsType<T>;
  readonly empty: string;
  readonly testId: string;
}): React.JSX.Element {
  const { referenceOf } = useApiErrorHandler();
  if (query.isError && !query.data) {
    const code = isApiError(query.error) ? query.error.code : undefined;
    return (
      <ErrorState
        code={code !== undefined && isErrorCode(code) ? code : undefined}
        requestId={referenceOf(query.error)}
        onRetry={() => void query.refetch()}
      />
    );
  }
  if (!query.data) return <LoadingSkeleton rows={4} />;
  if (query.data.pagination.total === 0) return <EmptyState title={empty} />;
  return (
    <Table<T>
      rowKey="id"
      data-testid={testId}
      columns={columns}
      dataSource={[...query.data.items]}
      loading={query.isFetching && query.isPlaceholderData}
      scroll={{ x: 'max-content' }}
      pagination={{
        current: page,
        pageSize: PAGE_SIZE,
        total: query.data.pagination.total,
        showSizeChanger: false,
        onChange: onPage,
      }}
    />
  );
}

/** The client's cases (`GET /cases?clientId=`), each opening its page. */
export function ClientFilesTab({ clientId }: { readonly clientId: string }): React.JSX.Element {
  const { t } = useTranslation();
  const format = useFormat();
  const [page, setPage] = useState(1);
  const query = useCasesList({ clientId, page: String(page), limit: String(PAGE_SIZE) });
  const columns: TableColumnsType<CaseListItem> = [
    {
      key: 'number',
      title: t('cases.list.columns.fileNumber'),
      render: (_, row) => <Ltr>{row.fileNumber}</Ltr>,
    },
    {
      key: 'title',
      title: t('cases.list.columns.title'),
      render: (_, row) => <TitleLink row={row} />,
    },
    {
      key: 'status',
      title: t('cases.list.columns.status'),
      render: (_, row) => <FileStatusTag status={row.status} />,
    },
    {
      key: 'updatedAt',
      title: t('cases.list.columns.updatedAt'),
      render: (_, row) => format.relative(row.updatedAt),
    },
  ];
  return (
    <PagedTable
      query={query}
      page={page}
      onPage={setPage}
      columns={columns}
      empty={t('clients.profile.files.empty')}
      testId="client-files"
    />
  );
}

/** A file named in a row: its number (left to right) linking to the given tab of its page. */
function FileLink({
  file,
  tab,
}: {
  readonly file: { id: string; fileNumber: string; title: string };
  readonly tab: string;
}): React.JSX.Element {
  return (
    <Link to={`/cases/${file.id}?tab=${tab}`}>
      <Ltr>{file.fileNumber}</Ltr> <Bdi>{file.title}</Bdi>
    </Link>
  );
}

/** Documents across the client's files (D-126 visibility), each pointing to its file's Documents tab. */
export function ClientDocumentsTab({ clientId }: { readonly clientId: string }): React.JSX.Element {
  const { t } = useTranslation();
  const format = useFormat();
  const [page, setPage] = useState(1);
  const query = useClientDocuments(clientId, page);
  const columns: TableColumnsType<ClientDocument> = [
    {
      key: 'name',
      title: t('clients.profile.columns.name'),
      render: (_, row) => <Bdi>{row.name}</Bdi>,
    },
    {
      key: 'file',
      title: t('clients.profile.columns.file'),
      render: (_, row) => <FileLink file={row.file} tab="documents" />,
    },
    {
      key: 'type',
      title: t('clients.profile.columns.type'),
      render: (_, row) => t(`enums.documentType.${row.documentType}`),
    },
    {
      key: 'status',
      title: t('clients.profile.columns.status'),
      render: (_, row) => (
        <StatusTag tone={STATUS_TONE[row.status]}>
          {t(`enums.documentStatus.${row.status}`)}
        </StatusTag>
      ),
    },
    {
      key: 'updatedAt',
      title: t('clients.profile.columns.updatedAt'),
      render: (_, row) => format.relative(row.updatedAt),
    },
  ];
  return (
    <PagedTable
      query={query}
      page={page}
      onPage={setPage}
      columns={columns}
      empty={t('clients.profile.documents.empty')}
      testId="client-documents"
    />
  );
}

/** The client's invoices the user may see (D-162); a draft has no number yet. */
export function ClientInvoicesTab({ clientId }: { readonly clientId: string }): React.JSX.Element {
  const { t } = useTranslation();
  const format = useFormat();
  const [page, setPage] = useState(1);
  const query = useClientInvoices(clientId, page);
  const columns: TableColumnsType<InvoiceListItem> = [
    {
      key: 'number',
      title: t('clients.profile.columns.invoiceNumber'),
      render: (_, row) =>
        row.invoiceNumber ? <Ltr>{row.invoiceNumber}</Ltr> : t('clients.profile.invoices.draft'),
    },
    {
      key: 'file',
      title: t('clients.profile.columns.file'),
      render: (_, row) =>
        row.file ? (
          <FileLink file={row.file} tab="billing" />
        ) : (
          t('clients.profile.invoices.consolidated')
        ),
    },
    {
      key: 'status',
      title: t('clients.profile.columns.status'),
      render: (_, row) => t(`enums.invoiceStatus.${row.status}`),
    },
    {
      key: 'total',
      title: t('clients.profile.columns.total'),
      render: (_, row) => <Bdi>{format.money(row.total, row.currency)}</Bdi>,
    },
    {
      key: 'dueDate',
      title: t('clients.profile.columns.dueDate'),
      render: (_, row) => (row.dueDate ? format.date(row.dueDate) : '—'),
    },
  ];
  return (
    <PagedTable
      query={query}
      page={page}
      onPage={setPage}
      columns={columns}
      empty={t('clients.profile.invoices.empty')}
      testId="client-invoices"
    />
  );
}
